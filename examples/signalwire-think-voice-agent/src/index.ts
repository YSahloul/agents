import { Think, type StreamCallback } from "@cloudflare/think";
import { Agent, getAgentByName, routeAgentRequest } from "agents";
import {
  createVoiceAgent,
  streamRpcVoiceTurn,
  WorkersAIFluxSTT,
  WorkersAIRealtimeTTS,
  type VoiceTurnContext
} from "@cloudflare/voice";
import { SignalWireAdapter } from "@cloudflare/voice-signalwire";
import { createWorkersAI } from "workers-ai-provider";

const DEFAULT_MODEL = "@cf/zai-org/glm-4.7-flash";
const DEFAULT_SYSTEM_PROMPT = [
  "You are a tire and wheel sales and customer-service agent for a retail auto parts business.",
  "You are speaking to the caller over a live phone call — audio only. The caller cannot see any screen, image, card, or link.",
  "Never mention visuals, never offer to show a card or image, and never ask the caller what they can see. Describe everything in spoken words.",
  "Callers ask you to find tires, wheels, and accessories by size, vehicle, brand, or use case.",
  "Use the connected retail tools as your source of truth for inventory, pricing, stock, and fitment. Never invent a product, price, or availability.",
  "Ask for the vehicle year/make/model or the tire/wheel size when a search needs it, then call the matching tool.",
  "Answer in 1-2 short spoken sentences. Be direct and natural. Never exceed 30 words unless the caller asks for detail."
].join(" ");

interface AgentConfigRow {
  system_prompt: string;
  model: string;
  mcp_server_url: string | null;
  retail_mcp_server_url: string | null;
}

/** Looks up per-business config by the dialed (`To`) number. Undefined when unconfigured. */
async function resolveCallConfig(
  db: D1Database,
  toNumber: string | undefined
): Promise<Record<string, unknown> | undefined> {
  if (!toNumber) return undefined;
  const row = await db
    .prepare(
      "SELECT system_prompt, model, mcp_server_url, retail_mcp_server_url FROM agent_configs WHERE phone_number = ?"
    )
    .bind(toNumber)
    .first<AgentConfigRow>();
  if (!row) return undefined;
  return {
    systemPrompt: row.system_prompt,
    model: row.model,
    mcpServerUrl: row.mcp_server_url ?? undefined,
    retailMcpServerUrl: row.retail_mcp_server_url ?? undefined
  };
}

export class MyThinkAgent extends Think<Env> {
  override waitForMcpConnections = { timeout: 3_000 };
  readonly #workersAi = createWorkersAI({ binding: this.env.AI });
  #callProps?: Record<string, unknown>;

  override getModel() {
    const model =
      (this.#callProps?.model as string | undefined) ?? DEFAULT_MODEL;
    return this.#workersAi(model, {
      sessionAffinity: this.sessionAffinity,
      reasoning_effort: null,
      chat_template_kwargs: { enable_thinking: false }
    });
  }

  override configureChannels() {
    return {
      voice: {
        kind: "voice" as const,
        ingress: { transport: "voice" as const },
        instructions:
          "Answer for live speech. Use one short, direct sentence. No markdown, tables, lists, unsupported actions, or promises of unsolicited follow-up."
      }
    };
  }

  override getSystemPrompt() {
    return (
      (this.#callProps?.systemPrompt as string | undefined) ??
      DEFAULT_SYSTEM_PROMPT
    );
  }

  async onStart(props?: Record<string, unknown>) {
    if (props) this.#callProps = props;
    const retailMcpServerUrl =
      (this.#callProps?.retailMcpServerUrl as string | undefined) ??
      this.env.RETAIL_MCP_SERVER_URL;
    if (retailMcpServerUrl) {
      await this.addMcpServer("retail", retailMcpServerUrl, {
        id: "retail"
      });
    }
  }

  async runVoiceTurn(
    transcript: string,
    callback: StreamCallback
  ): Promise<void> {
    await this.chat(transcript, callback, { channel: "voice" });
  }
}

const VoiceAgent = createVoiceAgent(Agent, {
  filterEchoedTranscripts: true,
  listenDuringCallStart: false,
  stt: (env: Env) =>
    new WorkersAIFluxSTT(env.AI, {
      eagerEotThreshold: 0.5,
      eotThreshold: 0.7
    }),
  tts: (env: Env) => new WorkersAIRealtimeTTS(env.AI),
  greeting: "Hello! How can I help you today?"
});

export class MyVoiceAgent extends VoiceAgent<Env> {
  async onTurn(
    transcript: string,
    context: VoiceTurnContext
  ): Promise<AsyncIterable<string>> {
    const brain = await getAgentByName(this.env.MyThinkAgent, this.name, {
      props: this.callProps
    });

    return streamRpcVoiceTurn({
      signal: context.signal,
      run: (callback) => brain.runVoiceTurn(transcript, callback),
      cancel: (requestId, reason) => brain.cancelChat(requestId, reason)
    });
  }
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);

    if (url.pathname === "/answer") {
      const body = await request.text();
      const params = new URLSearchParams(body);
      const toNumber = params.get("To") ?? "";
      const fromNumber = params.get("From") ?? "";
      const streamUrl = `wss://${url.host}/signalwire`;
      const xml = `<Response><Connect><Stream url="${streamUrl}" codec="PCMU@8000h" realtime="true"><Parameter name="To" value="${toNumber}" /><Parameter name="From" value="${fromNumber}" /></Stream></Connect></Response>`;
      return new Response(xml, {
        headers: { "Content-Type": "application/xml" }
      });
    }

    if (url.pathname === "/signalwire") {
      return SignalWireAdapter.handleRequest(
        request,
        env as unknown as Record<string, unknown>,
        "MyVoiceAgent",
        {
          agentAudioFormat: "mulaw",
          resolveProps: (start) =>
            resolveCallConfig(env.DB, start.customParameters?.To)
        }
      );
    }

    return (
      (await routeAgentRequest(request, env)) ??
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;

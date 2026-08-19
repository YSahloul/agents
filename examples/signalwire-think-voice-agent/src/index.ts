import { Think, type StreamCallback } from "@cloudflare/think";
import {
  Agent,
  getAgentByName,
  routeAgentRequest,
  type Connection
} from "agents";
import {
  streamRpcVoiceTurn,
  withVoice,
  WorkersAIFluxSTT,
  WorkersAIRealtimeTTS,
  type VoiceTurnContext
} from "@cloudflare/voice";
import { SignalWireAdapter } from "@cloudflare/voice-signalwire";
import { tool, type ToolSet } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { z } from "zod";

const MODEL = "@cf/moonshotai/kimi-k2.7-code";
const SYSTEM_PROMPT = [
  "You are a phone voice assistant. Respond in 1-2 short sentences.",
  "Use retail_agent for requests that need the retail MCP server.",
  "retail_agent dispatches one background retail sub-agent and returns immediately.",
  "When a request contains independent searches, issue one retail_agent call per distinct search in the same model step so they start in parallel.",
  "After dispatching, briefly confirm the searches are running and keep helping the caller.",
  "Never add overlapping, duplicate, or speculative searches, and never restart a search that is already running.",
  "When background completion messages arrive, use their results to answer the caller.",
  "Be direct and natural. Never exceed 30 words unless asked for detail."
].join(" ");

type RetailInput = { query: string };

export class RetailAgent extends Think<Env> {
  override maxSteps = 3;
  override waitForMcpConnections = { timeout: 3_000 };
  readonly #workersAi = createWorkersAI({ binding: this.env.AI });

  override getModel() {
    return this.#workersAi(MODEL, {
      sessionAffinity: this.sessionAffinity,
      reasoning_effort: null,
      chat_template_kwargs: { enable_thinking: false }
    });
  }

  override getSystemPrompt() {
    return [
      "You are a retail specialist.",
      "Discover and use the connected MCP server's available tools as the source of truth.",
      "Complete the request with those tools, return a concise factual summary, and do not invent missing data."
    ].join(" ");
  }

  async onStart() {
    await this.addMcpServer("retail", this.env.RETAIL_MCP_SERVER_URL, {
      id: "retail"
    });
  }
}

export class MyThinkAgent extends Think<Env> {
  override maxConcurrentAgentTools = 4;
  readonly #workersAi = createWorkersAI({ binding: this.env.AI });

  override getModel() {
    return this.#workersAi(MODEL, {
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
    return SYSTEM_PROMPT;
  }

  override getTools(): ToolSet {
    return {
      retail_agent: tool({
        description:
          "Dispatch one independent retail request to a background sub-agent. Call this same tool multiple times in one model step when independent requests can run in parallel.",
        inputSchema: z.object({ query: z.string().min(3) }),
        execute: async ({ query }, { toolCallId }) =>
          this.runAgentTool<RetailInput>(RetailAgent, {
            runId: `agent-tool:${toolCallId}`,
            parentToolCallId: toolCallId,
            input: { query },
            display: { name: "Retail specialist" },
            detached: { notify: true, maxBudgetMs: 5 * 60 * 1000 }
          })
      })
    };
  }

  async runVoiceTurn(
    transcript: string,
    callback: StreamCallback
  ): Promise<void> {
    await this.chat(transcript, callback, { channel: "voice" });
  }
}

const VoiceAgent = withVoice(Agent, {
  filterEchoedTranscripts: true,
  listenDuringCallStart: false,
  minInterruptWords: 3
});

export class MyVoiceAgent extends VoiceAgent<Env> {
  transcriber = new WorkersAIFluxSTT(this.env.AI, {
    eagerEotThreshold: 0.5,
    eotThreshold: 0.7
  });
  tts = new WorkersAIRealtimeTTS(this.env.AI);

  async onCallStart(connection: Connection) {
    console.log(`[call] instance=${this.name} — full conversation at /agents/my-think-agent/${this.name}/get-messages`);
    await this.speak(connection, "Hello! How can I help you today?");
  }

  async onTurn(
    transcript: string,
    context: VoiceTurnContext
  ): Promise<AsyncIterable<string>> {
    const brain = await getAgentByName(this.env.MyThinkAgent, this.name);

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
      const streamUrl = `wss://${url.host}/signalwire`;
      const xml = `<Response><Connect><Stream url="${streamUrl}" codec="PCMU@8000h" realtime="true" /></Connect></Response>`;
      return new Response(xml, {
        headers: { "Content-Type": "application/xml" }
      });
    }

    if (url.pathname === "/signalwire") {
      return SignalWireAdapter.handleRequest(
        request,
        env as unknown as Record<string, unknown>,
        "MyVoiceAgent",
        { agentAudioFormat: "mulaw" }
      );
    }

    return (
      (await routeAgentRequest(request, env)) ??
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;

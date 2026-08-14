import { Think, type StreamCallback } from "@cloudflare/think";
import { agentTool } from "agents/agent-tools";
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
import type { ToolSet } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { z } from "zod";

const MODEL = "@cf/zai-org/glm-4.7-flash";
const SYSTEM_PROMPT = [
  "You are a phone voice assistant. Respond in 1-2 short sentences.",
  "Use retail_agent for requests that need the retail MCP server.",
  "When a request contains independent searches, issue one retail_agent call per distinct search in the same model step so the existing sub-agent tool calls run in parallel.",
  "Before those calls, say one brief sentence so the caller hears that work has started while the sub-agents search.",
  "Never add overlapping, duplicate, or speculative searches.",
  "After all results return, summarize them briefly.",
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

  override getSystemPrompt() {
    return SYSTEM_PROMPT;
  }

  override getTools(): ToolSet {
    return {
      retail_agent: agentTool<RetailInput>(RetailAgent, {
        description:
          "Delegate one independent retail request to a sub-agent. Call this same tool multiple times in one model step when independent requests can run in parallel.",
        displayName: "Retail specialist",
        inputSchema: z.object({ query: z.string().min(3) })
      })
    };
  }

  async runVoiceTurn(
    transcript: string,
    callback: StreamCallback
  ): Promise<void> {
    await this.chat(transcript, callback);
  }
}

const VoiceAgent = withVoice(Agent, {
  filterEchoedTranscripts: true,
  listenDuringCallStart: false
});

export class MyVoiceAgent extends VoiceAgent<Env> {
  transcriber = new WorkersAIFluxSTT(this.env.AI, {
    eagerEotThreshold: 0.5,
    eotThreshold: 0.7
  });
  tts = new WorkersAIRealtimeTTS(this.env.AI);

  async onCallStart(connection: Connection) {
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

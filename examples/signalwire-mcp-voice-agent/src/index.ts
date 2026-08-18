import { Agent, routeAgentRequest } from "agents";
import { createMcpHandler } from "agents/mcp/server";
import {
  createVoiceAgent,
  WorkersAIFluxSTT,
  WorkersAIRealtimeTTS,
  type VoiceTurnContext
} from "@cloudflare/voice";
import { SignalWireAdapter } from "@cloudflare/voice-signalwire";
import { McpServer } from "@modelcontextprotocol/server";
import { isStepCount, streamText } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { z } from "zod";

const DEFAULT_SYSTEM_PROMPT = `You are a phone voice assistant testing MCP tools. Respond in 1-2 short sentences. Be direct and natural. Never exceed 30 words unless asked for detail. Use the current-time tool whenever the caller asks for the date or time. Use the retail tools for product, wheel, tire, accessory, price, fitment, image, and stock questions.`;
const DEFAULT_MODEL = "@cf/zai-org/glm-4.7-flash";

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

function createTestMcpServer() {
  const server = new McpServer({
    name: "SignalWire voice test tools",
    version: "1.0.0"
  });

  server.registerTool(
    "get_current_time",
    {
      description: "Get the current date and time in US Central Time.",
      inputSchema: z.object({})
    },
    (_args) => ({
      content: [
        {
          type: "text",
          text: new Intl.DateTimeFormat("en-US", {
            dateStyle: "full",
            timeStyle: "long",
            timeZone: "America/Chicago"
          }).format(new Date())
        }
      ]
    })
  );

  return server;
}

const handleMcpRequest = createMcpHandler(createTestMcpServer);

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
  async onStart(props?: Record<string, unknown>) {
    await super.onStart(props);
    const mcpServerUrl =
      (this.callProps?.mcpServerUrl as string | undefined) ??
      this.env.MCP_SERVER_URL;
    const retailMcpServerUrl =
      (this.callProps?.retailMcpServerUrl as string | undefined) ??
      this.env.RETAIL_MCP_SERVER_URL;
    if (mcpServerUrl) {
      await this.addMcpServer("voice-test-tools", mcpServerUrl, {
        id: "voice-test-tools"
      });
    }
    if (retailMcpServerUrl) {
      await this.addMcpServer("retail", retailMcpServerUrl, {
        id: "retail"
      });
    }
  }

  async onTurn(transcript: string, context: VoiceTurnContext) {
    await this.mcp.waitForConnections({ timeout: 3_000 });
    const workersAi = createWorkersAI({ binding: this.env.AI });

    const result = streamText({
      model: workersAi(
        (this.callProps?.model as string | undefined) ?? DEFAULT_MODEL,
        {
          sessionAffinity: this.sessionAffinity,
          reasoning_effort: null,
          chat_template_kwargs: { enable_thinking: false }
        }
      ),
      instructions:
        (this.callProps?.systemPrompt as string | undefined) ??
        DEFAULT_SYSTEM_PROMPT,
      messages: [
        ...context.messages.map((message) => ({
          role: message.role as "user" | "assistant",
          content: message.content
        })),
        { role: "user" as const, content: transcript }
      ],
      tools: this.mcp.getAITools(),
      stopWhen: isStepCount(3),
      onStepFinish: ({ finishReason, text, toolCalls, toolResults }) => {
        console.log("[MCPTrace]", {
          event: "model_step",
          connectionId: context.connection.id,
          finishReason,
          text,
          toolCalls: toolCalls.map(({ toolName, input }) => ({
            toolName,
            input
          })),
          toolResults: toolResults.map(({ toolName, output }) => ({
            toolName,
            output
          }))
        });
      },
      abortSignal: context.signal
    });

    return result.stream;
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname === "/mcp") {
      return handleMcpRequest(request, env, ctx);
    }

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

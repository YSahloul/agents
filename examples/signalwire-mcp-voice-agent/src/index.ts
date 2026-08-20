import { Agent, routeAgentRequest, type Connection } from "agents";
import { createMcpHandler } from "agents/mcp/server";
import {
  withVoice,
  WorkersAIFluxSTT,
  WorkersAIRealtimeTTS,
  type VoiceTurnContext
} from "@cloudflare/voice";
import { SignalWireAdapter } from "@cloudflare/voice-signalwire";
import { McpServer } from "@modelcontextprotocol/server";
import { isStepCount, streamText } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { z } from "zod";

const SYSTEM_PROMPT = `You are a phone voice assistant testing MCP tools. Respond in 1-2 short sentences. Be direct and natural. Never exceed 30 words unless asked for detail. Use the current-time tool whenever the caller asks for the date or time. Use the retail tools for product, wheel, tire, accessory, price, fitment, image, and stock questions.`;

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

const VoiceAgent = withVoice(Agent);

export class MyVoiceAgent extends VoiceAgent<Env> {
  transcriber = new WorkersAIFluxSTT(this.env.AI);
  tts = new WorkersAIRealtimeTTS(this.env.AI);

  async onStart() {
    await this.addMcpServer("voice-test-tools", this.env.MCP_SERVER_URL, {
      id: "voice-test-tools"
    });
    await this.addMcpServer("retail", this.env.RETAIL_MCP_SERVER_URL, {
      id: "retail"
    });
  }

  async onCallStart(connection: Connection) {
    await this.speak(connection, "Hello! How can I help you today?");
  }

  async onTurn(transcript: string, context: VoiceTurnContext) {
    await this.mcp.waitForConnections({ timeout: 3_000 });
    const workersAi = createWorkersAI({ binding: this.env.AI });

    const result = streamText({
      model: workersAi("@cf/zai-org/glm-4.7-flash", {
        sessionAffinity: this.sessionAffinity,
        reasoning_effort: null,
        chat_template_kwargs: { enable_thinking: false }
      }),
      instructions: SYSTEM_PROMPT,
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

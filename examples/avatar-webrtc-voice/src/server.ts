import {
  Think,
  Session,
  type StepContext,
  type ThinkChannels,
  type ToolCallContext,
  type ToolCallResultContext,
  type TurnConfig
} from "@cloudflare/think";
import { createSFUVoiceThink, voiceChannel } from "@cloudflare/think/voice";
import { callable, routeAgentRequest, type Connection } from "agents";
import {
  convertTTSProvider,
  mp3ToPcm16,
  WorkersAIFluxSTT,
  WorkersAIGrokTTS,
  type SFUConfig,
  type VoiceCallStartContext,
  type VoiceTurnContext
} from "@cloudflare/voice";
import { createWorkersAI } from "workers-ai-provider";
import { createCompactFunction } from "agents/experimental/memory/utils";
import type { ToolSet } from "ai";
import { generateText, hasToolCall, tool } from "ai";
import { z } from "zod";

/** The catalog marks reasoning models with a `reasoning: true` property
 * (observed on GLM, Kimi, DeepSeek-R1, gpt-oss, Qwen3, Gemma 4, Nemotron).
 * That is the authoritative flag — the model page's "Reasoning: Yes" maps to
 * exactly this property, so no description/tag sniffing needed. */
function isReasoningModel(m: {
  properties?: { property_id: string; value: string }[];
}): boolean {
  return (m.properties ?? []).some(
    (p) => p.property_id === "reasoning" && p.value === "true"
  );
}

const DEFAULT_MODEL = "@cf/moonshotai/kimi-k2.7-code";
const SYSTEM_PROMPT = `You are a helpful assistant with access to a persistent workspace filesystem.

Use the workspace tools to create, read, update, find, list, and delete files when requested. Confirm completed actions briefly.`;

type ReasoningEffort = "low" | "medium" | "high" | null;

function reasoningEffort(value: unknown): ReasoningEffort | undefined {
  if (value === null) return null;
  return value === "low" || value === "medium" || value === "high"
    ? value
    : undefined;
}

type ResearchInput = { query: string };

function inputText(input: unknown): string {
  if (typeof input === "string") return input;
  if (input && typeof input === "object" && "query" in input) {
    const query = input.query;
    if (typeof query === "string") return query;
  }
  return JSON.stringify(input, null, 2);
}

/** Copied from the agents-as-tools example: a retained Think helper agent. */
export class Researcher extends Think<Env> {
  override getModel() {
    return DEFAULT_MODEL;
  }

  override getSystemPrompt(): string {
    return [
      "You are a focused research helper agent.",
      "Use web_search once, then return a concise three-bullet summary."
    ].join(" ");
  }

  override formatAgentToolInput(input: unknown) {
    return {
      id: crypto.randomUUID(),
      role: "user" as const,
      parts: [{ type: "text" as const, text: inputText(input) }]
    };
  }

  override getTools(): ToolSet {
    return {
      web_search: tool({
        description:
          "Search for information on a topic. Returns simulated results for the demo.",
        inputSchema: z.object({ query: z.string().min(2) }),
        execute: async ({ query }) => {
          await this.reportProgress({
            phase: "searching",
            fraction: 0.25,
            message: `Searching for "${query}"…`
          });
          await scheduler.wait(20_000);
          await this.reportProgress({
            phase: "synthesizing",
            fraction: 0.75,
            message: "Synthesizing findings…"
          });
          return {
            query,
            results: [
              {
                title: `Background on "${query}"`,
                snippet:
                  `A concise overview of ${query}, including its main ` +
                  "trade-offs and production considerations."
              },
              {
                title: `Recent changes related to "${query}"`,
                snippet:
                  `Recent developments around ${query} and lessons from ` +
                  "open-source infrastructure deployments."
              }
            ]
          };
        }
      })
    };
  }
}

const VoiceThink = createSFUVoiceThink<Env>();

/** One Durable Object owns Think Session, Voice, SFU, tools, and workspace. */
export class MyThinkAgent extends VoiceThink {
  override workspaceBash = false;
  readonly #workersAi = createWorkersAI({ binding: this.env.AI });

  override getModel() {
    return DEFAULT_MODEL;
  }

  override getSystemPrompt() {
    return SYSTEM_PROMPT;
  }

  override configureChannels(): ThinkChannels {
    return {
      voice: voiceChannel({
        transcriber: new WorkersAIFluxSTT(this.env.AI, {
          eotThreshold: 0.7
        }),
        tts: convertTTSProvider({
          provider: new WorkersAIGrokTTS(this.env.AI, {
            voice: "ara",
            audioFormat: "mp3"
          }),
          converter: mp3ToPcm16({ sampleRate: 24000 })
        }),
        instructions:
          "You are speaking in a live WebRTC voice chat, so keep responses concise and natural for text-to-speech. Always return speakable text except when dispatching research_background: call it silently. Do not mention its start, progress, or completion unless the user asks.",
        maxTurns: 3
      })
    };
  }

  getSFUConfig(): SFUConfig {
    const env = this.env as Env & {
      REALTIME_SFU_APP_ID: string;
      REALTIME_SFU_BEARER_TOKEN: string;
      SFU_API_BASE?: string;
    };
    return {
      appId: env.REALTIME_SFU_APP_ID,
      apiToken: env.REALTIME_SFU_BEARER_TOKEN,
      apiBase: env.SFU_API_BASE
    };
  }

  override getVoiceTurnMetadata(
    _transcript: string,
    context: VoiceTurnContext
  ): Record<string, unknown> {
    const url = new URL(context.connection.uri ?? "http://localhost");
    const modelParam = url.searchParams.get("llm");
    const model =
      modelParam?.startsWith("@cf/") === true ? modelParam : DEFAULT_MODEL;
    const requestedReasoning = url.searchParams.get("reasoning");
    const effort =
      requestedReasoning === "off" ? null : reasoningEffort(requestedReasoning);
    return {
      model,
      ...(effort !== undefined && { reasoningEffort: effort })
    };
  }

  override async onCallStart(
    connection: Connection,
    { resumed }: VoiceCallStartContext
  ): Promise<void> {
    if (!resumed) await this.speak(connection, "Hi, how are you doing?");
  }

  override configureSession(session: Session): Session {
    return session
      .onCompaction(
        createCompactFunction({
          summarize: (prompt) =>
            generateText({ model: this.resolveModel(), prompt }).then(
              (r) => r.text
            ),
          tailTokenBudget: 8_000
        })
      )
      .compactAfter(20_000);
  }

  override beforeTurn(): TurnConfig {
    const metadata = this.activeTurnMetadata;
    const model =
      typeof metadata?.model === "string" && metadata.model.startsWith("@cf/")
        ? metadata.model
        : DEFAULT_MODEL;
    const effort = reasoningEffort(metadata?.reasoningEffort);

    return {
      model: this.#workersAi(model, {
        sessionAffinity: this.sessionAffinity,
        ...(effort !== undefined && {
          reasoning_effort: effort,
          ...(effort === null && {
            chat_template_kwargs: { enable_thinking: false }
          })
        })
      }),
      maxOutputTokens: 500,
      stopWhen: hasToolCall("research_background"),
      sendReasoning: false
    };
  }
  override getTools(): ToolSet {
    return {
      research_background: tool({
        description: "Dispatch a Researcher sub-agent in the background.",
        inputSchema: z.object({ query: z.string().min(3) }),
        execute: async ({ query }) => {
          const dispatched = await this.runAgentTool<ResearchInput>(
            Researcher,
            {
              input: { query },
              inputPreview: query,
              display: { name: "Researcher" },
              detached: {
                notify: { source: "voice-background-research" },
                maxBudgetMs: 5 * 60 * 1000
              }
            }
          );
          return {
            status: dispatched.status,
            runId: dispatched.runId,
            error: dispatched.error
          };
        }
      })
    };
  }

  @callable()
  async listWorkspaceFiles() {
    try {
      return (await this.workspace.glob("**/*")).filter(
        (entry) => entry.type === "file"
      );
    } catch {
      return [];
    }
  }

  override beforeToolCall(ctx: ToolCallContext): void {
    console.log("[ThinkTrace]", {
      event: "tool_call",
      toolCallId: ctx.toolCallId,
      toolName: ctx.toolName,
      stepNumber: ctx.stepNumber,
      input: ctx.input
    });
  }

  override afterToolCall(ctx: ToolCallResultContext): void {
    console.log("[ThinkTrace]", {
      event: "tool_result",
      toolCallId: ctx.toolCallId,
      toolName: ctx.toolName,
      stepNumber: ctx.stepNumber,
      durationMs: ctx.toolExecutionMs,
      ...(ctx.toolOutput.type === "tool-result"
        ? { output: ctx.toolOutput.output }
        : { error: ctx.toolOutput.error })
    });
  }

  override onStepEnd(ctx: StepContext): void {
    console.log("[ThinkTrace]", {
      event: "step_end",
      finishReason: ctx.finishReason,
      usage: ctx.usage
    });
  }
}

export default {
  async fetch(request: Request, env: Env) {
    // List text-generation models from the Workers AI binding so the UI
    // dropdown can be populated dynamically (reasoning + fast models).
    // Token-free — no API key required, unlike the REST search endpoint.
    if (new URL(request.url).pathname === "/models") {
      const models = await env.AI.models({
        task: "Text Generation",
        per_page: 100
      });
      // The binding returns `name` as the @cf/... model id and `id` as a
      // catalog UUID — send the model id through as `id`.
      return Response.json(
        models.map((m) => ({
          id: m.name,
          reasoning: isReasoningModel(m)
        }))
      );
    }
    return (
      (await routeAgentRequest(request, env)) ??
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;

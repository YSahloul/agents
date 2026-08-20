import {
  Think,
  Session,
  type StreamCallback,
  type StepContext,
  type ThinkChannels,
  type ToolCallContext,
  type ToolCallResultContext,
  type TurnConfig
} from "@cloudflare/think";
import {
  Agent,
  callable,
  getAgentByName,
  routeAgentRequest,
  type Connection
} from "agents";
import {
  convertTTSProvider,
  mp3ToPcm16,
  streamRpcVoiceTurn,
  withSFUVoice,
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

/**
 * Some reasoning models (Kimi K2, DeepSeek-R1/QwQ-style templates) prime the
 * prompt with an implicit `<think>` and only emit the closing `</think>` in
 * the completion -- even with `chat_template_kwargs: { enable_thinking: false }`
 * set, Workers AI does not honor it for every reasoning model. Buffer text
 * until the first `</think>` and drop everything up to it so reasoning is
 * never spoken or shown. If no closing tag ever appears, flush the buffered
 * text unchanged at stream end -- normal answers are never lost, only
 * unbuffered late.
 * ponytail: buffers the whole turn when a model never emits `</think>`,
 * losing early TTS start for that turn. Upgrade: key this off the model's
 * `reasoning` catalog flag once `onTurn` can see it.
 */
async function* stripThinkTags(
  source: AsyncIterable<string>
): AsyncGenerator<string> {
  const CLOSE_TAG = "</think>";
  let buffering = true;
  let buffer = "";
  for await (const chunk of source) {
    if (!buffering) {
      yield chunk;
      continue;
    }
    buffer += chunk;
    const closeIndex = buffer.indexOf(CLOSE_TAG);
    if (closeIndex === -1) continue;
    buffering = false;
    const after = buffer.slice(closeIndex + CLOSE_TAG.length);
    buffer = "";
    if (after) yield after;
  }
  if (buffering && buffer) yield buffer;
}

const DEFAULT_MODEL = "@cf/moonshotai/kimi-k2.7-code";
const SYSTEM_PROMPT = `You are a helpful assistant with access to a persistent workspace filesystem.

Use the workspace tools to create, read, update, find, list, and delete files when requested. Confirm completed actions briefly.`;

type ReasoningEffort = "low" | "medium" | "high" | null;

interface VoiceTurnOptions extends Record<string, unknown> {
  model: string;
  reasoningEffort?: ReasoningEffort;
}

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

/**
 * Canonical conversation agent. It owns the transcript, model, tools, memory,
 * and workspace. The voice agent below only translates audio to and from this
 * agent over RPC.
 */
export class MyThinkAgent extends Think<Env> {
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
      voice: {
        kind: "voice",
        ingress: { transport: "voice" },
        instructions:
          "You are speaking in a live WebRTC voice chat, so keep responses concise and natural for text-to-speech. Always return speakable text except when dispatching research_background: call it silently. Do not mention its start, progress, or completion unless the user asks.",
        maxTurns: 3
      }
    };
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

  async runVoiceTurn(
    turnId: string,
    transcript: string,
    callback: StreamCallback,
    options: VoiceTurnOptions
  ): Promise<void> {
    const startedAt = Date.now();
    console.log("[ThinkTrace]", {
      event: "turn_start",
      turnId,
      model: options.model,
      reasoningEffort: options.reasoningEffort
    });

    try {
      await this.chat(transcript, callback, {
        metadata: options,
        channel: "voice"
      });
      console.log("[ThinkTrace]", {
        event: "turn_end",
        turnId,
        durationMs: Date.now() - startedAt
      });
    } catch (error) {
      console.error("[ThinkTrace]", {
        event: "turn_error",
        turnId,
        durationMs: Date.now() - startedAt,
        error
      });
      throw error;
    }
  }
}

const VoiceAgent = withSFUVoice(Agent);

export class MyVoiceAgent extends VoiceAgent<Env> {
  tts = convertTTSProvider({
    provider: new WorkersAIGrokTTS(this.env.AI, {
      voice: "ara",
      audioFormat: "mp3"
    }),
    converter: mp3ToPcm16({ sampleRate: 24000 })
  });
  transcriber = new WorkersAIFluxSTT(this.env.AI, {
    eotThreshold: 0.7
  });

  readonly #greeting = "Hi, how are you doing?";

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

  // --- Voice agent logic ---

  async onTurn(
    transcript: string,
    context: VoiceTurnContext
  ): Promise<AsyncIterable<string>> {
    const url = new URL(context.connection.uri ?? "http://localhost");
    const modelParam = url.searchParams.get("llm");
    const model =
      modelParam?.startsWith("@cf/") === true ? modelParam : DEFAULT_MODEL;
    const requestedReasoning = url.searchParams.get("reasoning");
    const effort =
      requestedReasoning === "off" ? null : reasoningEffort(requestedReasoning);

    const brain = await getAgentByName(this.env.MyThinkAgent, this.name);
    const turnId = crypto.randomUUID();
    return stripThinkTags(
      streamRpcVoiceTurn({
        signal: context.signal,
        run: (callback) =>
          brain.runVoiceTurn(turnId, transcript, callback, {
            model,
            ...(effort !== undefined && { reasoningEffort: effort })
          }),
        cancel: (requestId, reason) => brain.cancelChat(requestId, reason),
        onRequestId: (requestId) => {
          console.log("[ThinkTrace]", {
            event: "request_start",
            turnId,
            requestId
          });
        }
      })
    );
  }

  async onCallStart(
    connection: Connection,
    { resumed }: VoiceCallStartContext
  ) {
    if (!resumed) await this.speak(connection, this.#greeting);
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

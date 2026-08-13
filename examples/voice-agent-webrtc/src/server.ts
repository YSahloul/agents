import { TextStreamCallback } from "@cloudflare/think/messengers";
import { Think, type ChatStartEvent, type TurnConfig } from "@cloudflare/think";
import {
  Agent,
  getAgentByName,
  routeAgentRequest,
  type Connection,
  type WSMessage
} from "agents";
import {
  withSFUVoice,
  WorkersAIFluxSTT,
  WorkersAIRealtimeTTS,
  type SFUConfig,
  type VoiceTurnContext
} from "@cloudflare/voice";
import { createWorkersAI } from "workers-ai-provider";

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

You are speaking in a live WebRTC voice chat, so keep responses concise and natural for text-to-speech. Always return speakable text.

Use the workspace tools to create, read, update, find, list, and delete files when requested. Confirm completed workspace actions briefly.`;

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

class VoiceReplyCallback extends TextStreamCallback {
  #failure?: Error;

  constructor(private readonly registerRequest: (requestId: string) => void) {
    super();
  }

  override onStart(event: ChatStartEvent): void {
    super.onStart(event);
    this.registerRequest(event.requestId);
  }

  override onError(error: string): void {
    this.#failure = new Error(error);
    super.onError(error);
  }

  get failure(): Error | undefined {
    return this.#failure;
  }
}

/**
 * Canonical conversation agent. It owns the transcript, model, tools, memory,
 * and workspace. The voice agent below only translates audio to and from this
 * agent over RPC.
 */
export class MyThinkAgent extends Think<Env> {
  override maxSteps = 3;
  override workspaceBash = false;
  readonly #workersAi = createWorkersAI({ binding: this.env.AI });
  readonly #voiceRequests = new Map<string, string>();
  readonly #cancelledVoiceTurns = new Set<string>();

  override getModel() {
    return DEFAULT_MODEL;
  }

  override getSystemPrompt() {
    return SYSTEM_PROMPT;
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
      maxOutputTokens: 8192,
      sendReasoning: false
    };
  }

  async runVoiceTurn(
    turnId: string,
    transcript: string,
    options: VoiceTurnOptions
  ): Promise<string> {
    const callback = new VoiceReplyCallback((requestId) => {
      this.#voiceRequests.set(turnId, requestId);
      if (this.#cancelledVoiceTurns.delete(turnId)) {
        this.cancelChat(requestId, "Voice turn interrupted");
      }
    });

    try {
      await this.chat(transcript, callback, {
        metadata: options
      });
      if (callback.failure) throw callback.failure;
      if (callback.wasInterrupted()) {
        throw new Error("Voice turn interrupted");
      }
      return callback.textSoFar().trim();
    } finally {
      this.#voiceRequests.delete(turnId);
      this.#cancelledVoiceTurns.delete(turnId);
    }
  }

  cancelVoiceTurn(turnId: string): void {
    const requestId = this.#voiceRequests.get(turnId);
    if (requestId) {
      this.cancelChat(requestId, "Voice turn interrupted");
    } else {
      this.#cancelledVoiceTurns.add(turnId);
    }
  }
}

const VoiceAgent = withSFUVoice(Agent);

export class MyVoiceAgent extends VoiceAgent<Env> {
  tts = new WorkersAIRealtimeTTS(this.env.AI, {
    model: "@cf/deepgram/aura-2-en",
    speaker: "draco",
    encoding: "linear16",
    sampleRate: 24000
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

  // --- Single-speaker enforcement ---
  //
  // Only one connection can be the active speaker at a time. This prevents
  // two browser tabs from capturing audio simultaneously. Other connections
  // can still observe transcripts and send text messages.

  #activeSpeakerId: string | null = null;
  #greetingPlaying = false;

  beforeCallStart(connection: Connection): boolean {
    if (this.#activeSpeakerId && this.#activeSpeakerId !== connection.id) {
      connection.send(
        JSON.stringify({
          type: "speaker_conflict",
          message:
            "Another session is currently the active speaker. You can kick them to take over."
        })
      );
      return false;
    }
    this.#activeSpeakerId = connection.id;
    return true;
  }

  onCallEnd(connection: Connection) {
    if (this.#activeSpeakerId === connection.id) {
      this.#activeSpeakerId = null;
    }
  }

  onClose(connection: Connection) {
    if (this.#activeSpeakerId === connection.id) {
      this.#activeSpeakerId = null;
    }
  }

  onMessage(connection: Connection, message: WSMessage) {
    // Voice protocol messages are intercepted automatically by the mixin.
    // This handler only receives non-voice messages.
    if (typeof message === "string") {
      try {
        const parsed = JSON.parse(message);
        if (parsed.type === "kick_speaker") {
          this.#handleKick(connection);
          return;
        }
      } catch {
        // not JSON
      }
    }
  }

  #handleKick(requester: Connection) {
    if (!this.#activeSpeakerId) {
      // No active speaker — nothing to kick
      return;
    }

    const activeConn = [...this.getConnections()].find(
      (c) => c.id === this.#activeSpeakerId
    );

    if (activeConn) {
      // Notify the kicked connection
      activeConn.send(
        JSON.stringify({
          type: "kicked",
          message: "Another session has taken over as the active speaker."
        })
      );
      // Force end their call — cleans up server-side state and sends idle
      this.forceEndCall(activeConn);
    }

    this.#activeSpeakerId = null;

    // Notify the requester they can now start
    requester.send(
      JSON.stringify({
        type: "speaker_available",
        message: "Previous speaker has been disconnected. You can start a call."
      })
    );
  }

  receiveAudio(connectionId: string, audio: ArrayBuffer): void {
    if (!this.#greetingPlaying) super.receiveAudio(connectionId, audio);
  }

  // --- Voice agent logic ---

  async onTurn(transcript: string, context: VoiceTurnContext): Promise<string> {
    const url = new URL(context.connection.uri ?? "http://localhost");
    const modelParam = url.searchParams.get("llm");
    const model =
      modelParam?.startsWith("@cf/") === true ? modelParam : DEFAULT_MODEL;
    const requestedReasoning = url.searchParams.get("reasoning");
    const effort =
      requestedReasoning === "off" ? null : reasoningEffort(requestedReasoning);

    const brain = await getAgentByName(this.env.MyThinkAgent, this.name);
    const turnId = crypto.randomUUID();
    const cancel = () => {
      void brain.cancelVoiceTurn(turnId).catch((error) => {
        console.error("[VoiceAgent] Failed to cancel Think turn:", error);
      });
    };

    context.signal.addEventListener("abort", cancel, { once: true });
    if (context.signal.aborted) cancel();

    try {
      return (
        (await brain.runVoiceTurn(turnId, transcript, {
          model,
          ...(effort !== undefined && { reasoningEffort: effort })
        })) || "Sorry, I didn't catch a response."
      );
    } finally {
      context.signal.removeEventListener("abort", cancel);
    }
  }

  async onCallStart(connection: Connection) {
    this.#greetingPlaying = true;
    try {
      await this.speak(connection, this.#greeting);
      await new Promise((resolve) => setTimeout(resolve, 250));
    } finally {
      this.#greetingPlaying = false;
    }
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

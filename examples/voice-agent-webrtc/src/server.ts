import {
  Agent,
  routeAgentRequest,
  type Connection,
  type WSMessage
} from "agents";
import {
  withSFUVoice,
  WorkersAIFluxSTT,
  WorkersAITTS,
  type SFUConfig,
  type VoiceTurnContext
} from "@cloudflare/voice";
import { streamText, stepCountIs } from "ai";
import { createWorkersAI } from "workers-ai-provider";

/** Stops the agent answering its own TTS, which an open mic/speaker (no
 * headset) or SFU loopback can pick up as if it were user speech. Local to
 * this example — not a library concern. */
function isEchoOf(transcript: string, assistantText: string): boolean {
  if (!assistantText) return false;
  const a =
    assistantText
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu)
      ?.join(" ") ?? "";
  const heard = transcript.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (heard.length >= 3 && a.includes(heard.join(" "))) return true;
  const aWords = new Set(a.split(" "));
  const hits = heard.filter((w) => aWords.has(w)).length;
  return hits >= 4 && hits / heard.length >= 0.6;
}

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

const VoiceAgent = withSFUVoice(Agent);

const SYSTEM_PROMPT = `You are a stand-up comedian voice assistant. Your entire purpose is to tell jokes, make people laugh, and keep the mood light. You're being spoken aloud through text-to-speech, so every line must be short, punchy, and natural when heard — not read.

You have ONE job: be funny. Every response should either set up a joke, deliver a punchline, or react with comedic timing. No small talk, no pleasantries, no tools, no utility. Just jokes.

PERSONALITY: A charismatic club comic who loves the craft. Warm but sharp, a little theatrical, never mean-spirited. You read the room. If the user's into it, you riff. If they groan, you lean into the groan — that's part of the act too.

VOICE DELIVERY RULES:
- One short line per response, then stop. Never monologue.
- Pauses are rhythm. A joke needs space to land before the next line.
- Never answer your own setup. Never reveal your own punchline until the user says the expected line.
- If speech-to-text garbles the user, guess what they meant and roll with it. If it's genuinely off twice, pivot — never repeat the same line three times.

KNOCK-KNOCK PROTOCOL — strictly one line per turn:
  You: "Knock knock."
  User: "Who's there?"
  You: "Lettuce."
  User: "Lettuce who?"
  You: "Lettuce in, it's cold out here."

On a knock-knock request, your entire response is "Knock knock." — nothing else. Follow the rhythm. The user leads the back-and-forth.

JOKE REPERTOIRE: knock-knocks, one-liners, puns, riddles, short story jokes, observational comedy. Avoid the overused jokes every language model defaults to — no "bicycle fell over / two-tired," no "baker / dough," no "atoms / make up everything." Dig deeper. If a joke feels obvious and predictable to you, it is — pick another.

FIRST TURN: Listen. If the user says "tell me a joke" or anything like it, launch straight into one. Don't greet, don't introduce yourself — you're already on stage.`;

export class MyVoiceAgent extends VoiceAgent<Env> {
  tts = new WorkersAITTS(this.env.AI, {
    encoding: "linear16",
    container: "none",
    sampleRate: 24000
  });
  transcriber = new WorkersAIFluxSTT(this.env.AI, {
    eotThreshold: 0.7,
    eagerEotThreshold: 0.5
  });

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

  // --- Voice agent logic ---

  async onTurn(transcript: string, context: VoiceTurnContext) {
    const workersAi = createWorkersAI({ binding: this.env.AI });

    const url = new URL(context.connection.uri ?? "http://localhost");
    // `llm` is a full Workers AI model id (@cf/...). Accept any @cf/... id so
    // the UI dropdown can pick any catalog model; default to GLM. Unknown ids
    // are rejected by the binding at run time — no allowlist needed.
    const llmParam = url.searchParams.get("llm");
    const llmModel =
      llmParam && llmParam.startsWith("@cf/")
        ? llmParam
        : "@cf/zai-org/glm-4.7-flash";
    // Reasoning effort for reasoning models. 'off' disables reasoning
    // (reasoning_effort: null → no chain-of-thought, lowest latency);
    // 'low'|'medium'|'high' sets the budget. Absent = model default.
    const reasoning = url.searchParams.get("reasoning");
    const reasoningEffort: "low" | "medium" | "high" | null | undefined =
      reasoning === "low" || reasoning === "medium" || reasoning === "high"
        ? reasoning
        : reasoning === "off"
          ? null
          : undefined;

    const messages = [
      ...context.messages.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content
      })),
      { role: "user" as const, content: transcript }
    ];

    // Log the EXACT request sent to the LLM — full message array, system
    // prompt, model, and generation config. Without this, "why did the model
    // say X" is unanswerable from logs. rawMessagesJson is JSON.stringify'd
    // (not console.log's object inspector) so duplicate entries are visible
    // as literal repeated text, not collapsed/summarized in any way.
    console.log("[VoiceTrace]", {
      event: "llm_request",
      connectionId: context.connection.id,
      model: llmModel,
      maxOutputTokens: 8192,
      reasoningEffort,
      stopWhenSteps: 3,
      messageCount: messages.length,
      system: SYSTEM_PROMPT,
      messages,
      rawMessagesJson: JSON.stringify(messages)
    });

    const result = streamText({
      model: workersAi(llmModel, {
        sessionAffinity: this.sessionAffinity,
        ...(reasoningEffort !== undefined && {
          reasoning_effort: reasoningEffort,
          // GLM/Kimi expose thinking via the chat template, not reasoning_effort
          // (verified: enable_thinking: false → 0 reasoning tokens on GLM;
          // reasoning_effort: null alone still burns ~7.6k reasoning chars).
          // gpt-oss ignores this knob but respects reasoning_effort (low → ~400).
          ...(reasoningEffort === null && {
            chat_template_kwargs: { enable_thinking: false }
          })
        })
      }),
      // Reasoning models (GLM, gpt-oss-20b) burn output tokens on chain-of-thought
      // before emitting the answer. GLM-4.7-flash burns ~3500+ reasoning tokens;
      // 1024 exhausts mid-reasoning and the agent goes silent (finishReason 'length', text '').
      maxOutputTokens: 8192,
      system: SYSTEM_PROMPT,
      messages,
      onStepFinish: ({ finishReason, text, usage }) => {
        console.log("[VoiceTrace]", {
          event: "llm_step_finish",
          connectionId: context.connection.id,
          finishReason,
          textLen: text.length,
          text,
          usage
        });
      },
      stopWhen: stepCountIs(3),
      abortSignal: context.signal
    });

    return (async function* () {
      // Log the RAW model output — every part of the stream, including
      // reasoning/thinking tokens (invisible in onStepFinish's text field).
      let streamText_ = "";
      let streamReasoning = "";
      for await (const part of result.fullStream) {
        if (part.type === "text-delta") streamText_ += part.text;
        if (part.type === "reasoning-delta") streamReasoning += part.text;
        if (part.type === "finish") {
          console.log("[VoiceTrace]", {
            event: "llm_response_raw",
            connectionId: context.connection.id,
            finishReason: part.finishReason,
            totalUsage: part.totalUsage,
            textLen: streamText_.length,
            text: streamText_,
            reasoningLen: streamReasoning.length,
            reasoning: streamReasoning
          });
        }
        yield part;
      }
    })();
  }

  // No auto-greeting on call start: the greeting fired on every reconnect
  // (persisted history made it say "Welcome back!" mid-conversation), which
  // interjected into in-flight turns. The agent only speaks in response to
  // the user now.
  async onCallStart(_connection: Connection) {}

  override afterTranscribe(transcript: string): string | null {
    const history = this.getConversationHistory();
    let lastAssistant = "";
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].role === "assistant") {
        lastAssistant = history[i].content;
        break;
      }
    }
    if (isEchoOf(transcript, lastAssistant)) return null;
    return transcript;
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

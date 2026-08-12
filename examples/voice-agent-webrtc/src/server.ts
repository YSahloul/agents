import {
  Agent,
  routeAgentRequest,
  type Connection,
  type WSMessage
} from "agents";
import {
  withSFUVoice,
  WorkersAIFluxSTT,
  WorkersAIRealtimeTTS,
  type SFUConfig,
  type StreamingTTSProvider,
  type TTSProvider,
  type VoiceTurnContext
} from "@cloudflare/voice";
import { streamText, stepCountIs } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import {
  createElevenLabsVoiceTTS,
  getMissingTtsProviderKey
} from "./tts-providers";

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

const SYSTEM_PROMPT = `# Personality

You are a quick-witted roast comic chatting with one person. Sound like their funniest close friend: observant, dry, confident, and on their side.
You are speaking in a live WebRTC voice chat. Every response is sent directly to text-to-speech. Always return speakable text; never return an empty response.

# Conversation

The automatic greeting has already welcomed the user. Continue naturally from whatever they say.
Questions are optional. Ask only when genuinely curious or when clarification is necessary. Never force a question at the end of a response.
Respond to what they just said. Remember details and use callbacks. Let banter breathe instead of interviewing them.
Always reply with at least one spoken sentence, even to acknowledgements. A question is never required.

# Style

Usually speak one punchy sentence. Never exceed twenty words unless answering a direct factual question.
Skip filler, setup, explanations, repeated names, greetings, and phrases like "nice to meet you."
Use contractions, fragments, understatement, wordplay, and dry delivery.

# Comedy

Roast specific details the user shared. Think disappointed friend meets stand-up comic.
Target harmless choices, weak excuses, overconfidence, bad luck, and the situation—not the person's worth.
If the user roasts you, fire back without getting defensive.

Examples:
User: "My name is James."
You: "James—your parents really feared risk. What do you do for fun?"
User: "Coffee and a movie."
You: "A Sunday routine with all the danger of a library card."
User: "You're talking too slow."
You: "Fair. Even my insults were buffering."

# Guardrails

Never target identity, protected traits, appearance, disability, health, trauma, grief, family, finances, or genuine insecurity.
No threats, slurs, sexual humiliation, harassment, or encouragement of harm.
If the user sounds upset or asks you to stop, drop the roast and respond supportively without announcing the change.
Never narrate actions, use stage directions, write emoji, or mention being an AI.`;

export class MyVoiceAgent extends VoiceAgent<Env> {
  tts: TTSProvider & Partial<StreamingTTSProvider> = new WorkersAIRealtimeTTS(
    this.env.AI,
    {
      model: "@cf/deepgram/aura-2-en",
      speaker: "draco",
      encoding: "linear16",
      sampleRate: 24000
    }
  );
  readonly #auraTts = this.tts;
  transcriber = new WorkersAIFluxSTT(this.env.AI, {
    eotThreshold: 0.7,
    eagerEotThreshold: 0.7
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
    const missingKey = getMissingTtsProviderKey(connection, this.env);
    if (missingKey) {
      connection.send(JSON.stringify({ type: "error", message: missingKey }));
      return false;
    }

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
    this.tts = createElevenLabsVoiceTTS(connection, this.env) ?? this.#auraTts;
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

  async onTurn(transcript: string, context: VoiceTurnContext) {
    const workersAi = createWorkersAI({ binding: this.env.AI });

    const url = new URL(context.connection.uri ?? "http://localhost");
    // `llm` is a full Workers AI model id (@cf/...). Accept any @cf/... id so
    // the UI dropdown can pick any catalog model; default to Llama 4 Scout.
    // Unknown ids are rejected by the binding at run time — no allowlist needed.
    const llmParam = url.searchParams.get("llm");
    const llmModel =
      llmParam && llmParam.startsWith("@cf/")
        ? llmParam
        : "@cf/meta/llama-4-scout-17b-16e-instruct";
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

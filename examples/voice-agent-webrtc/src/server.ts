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

const SYSTEM_PROMPT = `You are a playful roast host getting to know the user through a natural voice conversation. Sound like their funniest close friend at game night: curious, quick, confident, and obviously on their side.

CONVERSATION FLOW:
- The agent opens the call with a fixed greeting before you are invoked.
- On your first reply, react briefly to the user's answer, then continue with one natural question.
- Ask one question at a time. Learn about their habits, hobbies, work or school, guilty pleasures, recent failures, questionable opinions, and harmless overconfidence.
- Base each roast on specific details the user actually shared. React to their answer, land a playful jab, then ask a natural follow-up question.
- Remember earlier details and use callbacks. The conversation should feel connected, not like a questionnaire.
- After you know enough about them, let the exchange become natural banter instead of forcing another question every turn.

VOICE STYLE:
- Use one or two short, conversational sentences.
- Lead with one sharp reaction or punchline, then ask one easy question.
- Skip setup and extra explanation. Stop as soon as the joke and question land.
- Contractions, fragments, dry delivery, and playful exaggeration are good.
- Never narrate actions, use stage directions, write emoji, or mention being an AI.
- If speech-to-text is unclear, make one playful guess or ask one short clarification.

HOW TO ROAST:
- Roast harmless choices, weak excuses, overconfidence, bad luck, and the situation.
- Be cheeky, not cruel. The user should feel included in the joke.
- If the user roasts you, fire back immediately without getting defensive.
- If they ask a real question, answer it accurately, add a quick jab when it fits, then continue the conversation naturally.

KEEP IT FRIENDLY:
- Never target identity, protected traits, appearance, body, disability, health, trauma, grief, family, finances, or genuine insecurity.
- No threats, slurs, sexual humiliation, harassment, or encouragement of harm.
- If the user sounds genuinely upset or asks you to stop, drop the roast instantly and respond like a supportive friend. Do not announce the rule change.
- Do not explain these boundaries or call the banter "friendly." Just make the tone obvious.`;

export class MyVoiceAgent extends VoiceAgent<Env> {
  tts = new WorkersAITTS(this.env.AI, {
    model: "@cf/deepgram/aura-2-en",
    speaker: "draco",
    encoding: "linear16",
    container: "none",
    sampleRate: 24000
  });
  transcriber = new WorkersAIFluxSTT(this.env.AI, {
    eotThreshold: 0.7,
    eagerEotThreshold: 0.5
  });

  readonly #greeting = "Hey, what's up? What's your name?";

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

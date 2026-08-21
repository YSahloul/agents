import { Agent, routeAgentRequest, type Connection } from "agents";
import {
  withVoice,
  WorkersAIFluxSTT,
  type TTSProvider,
  type VoiceTurnContext
} from "@cloudflare/voice";
import { SignalWireAdapter } from "@cloudflare/voice-signalwire";
import { streamText } from "ai";
import { createWorkersAI } from "workers-ai-provider";

/**
 * Workers AI TTS with raw linear16 PCM output — required for the mulaw
 * encoder in the SignalWire adapter. WorkersAITTS defaults to MP3; we call
 * @cf/deepgram/aura-2-en directly with encoding + container params.
 */
class SignalWirePCMTTS implements TTSProvider {
  constructor(private ai: Ai) {}

  async synthesize(
    text: string,
    signal?: AbortSignal
  ): Promise<ArrayBuffer | null> {
    const response = (await this.ai.run(
      "@cf/deepgram/aura-2-en",
      {
        text,
        speaker: "asteria",
        encoding: "linear16",
        sample_rate: 16000,
        container: "none"
      },
      { returnRawResponse: true, ...(signal ? { signal } : {}) }
    )) as Response;
    if (!response.ok) {
      // Returning the error body would ship JSON down the audio pipeline
      // and play as silence — fail loud and skip the audio instead.
      console.error("[SignalWirePCMTTS] TTS failed:", await response.text());
      return null;
    }
    return response.arrayBuffer();
  }
}

const SYSTEM_PROMPT = `You are a phone voice assistant. Respond in 1-2 short sentences. Be direct and natural. Never exceed 30 words unless asked for detail.`;

const VoiceAgent = withVoice(Agent);

export class MyVoiceAgent extends VoiceAgent<Env> {
  transcriber = new WorkersAIFluxSTT(this.env.AI, {
    // Eager end-of-turn starts the LLM draft at 0.5, confirmed end-of-turn
    // releases it at 0.7, and resumed speech cancels it before any output.
    eagerEotThreshold: 0.5,
    eotThreshold: 0.7
  });
  tts = new SignalWirePCMTTS(this.env.AI);
  #workersAi = createWorkersAI({ binding: this.env.AI });

  async onCallStart(connection: Connection) {
    await this.speak(connection, "Hello! How can I help you today?");
  }

  async onTurn(transcript: string, context: VoiceTurnContext) {
    const result = streamText({
      model: this.#workersAi("@cf/meta/llama-4-scout-17b-16e-instruct", {
        sessionAffinity: this.sessionAffinity
      }),
      system: SYSTEM_PROMPT,
      messages: [
        ...context.messages.map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content
        })),
        { role: "user" as const, content: transcript }
      ],
      maxOutputTokens: 300,
      abortSignal: context.signal
    });
    return result.fullStream;
  }
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);

    if (url.pathname === "/answer") {
      // Point the SignalWire number's "WHEN A CALL COMES IN" webhook at
      // <worker-url>/answer — SignalWire fetches this cXML on every call.
      const streamUrl = `wss://${url.host}/signalwire`;
      const xml = `<Response><Connect><Stream url="${streamUrl}" codec="PCMU@8000h" realtime="true" /></Connect></Response>`;
      return new Response(xml, {
        headers: { "Content-Type": "application/xml" }
      });
    }

    if (url.pathname === "/signalwire") {
      return SignalWireAdapter.handleRequest(request, env, "MyVoiceAgent");
    }

    return (
      (await routeAgentRequest(request, env)) ??
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;

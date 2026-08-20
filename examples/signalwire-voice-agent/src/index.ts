import { Agent, routeAgentRequest, type Connection } from "agents";
import {
  withVoice,
  WorkersAIFluxSTT,
  WorkersAIRealtimeTTS,
  type VoiceTurnContext
} from "@cloudflare/voice";
import { SignalWireAdapter } from "@cloudflare/voice-signalwire";
import { streamText } from "ai";
import { createWorkersAI } from "workers-ai-provider";

const SYSTEM_PROMPT = `You are a phone voice assistant. Respond in 1-2 short sentences. Be direct and natural. Never exceed 30 words unless asked for detail.`;

const VoiceAgent = withVoice(Agent);

export class MyVoiceAgent extends VoiceAgent<Env> {
  transcriber = new WorkersAIFluxSTT(this.env.AI);
  // WebSocket μ-law TTS (the rebuilt synthesizeStream path): one socket per
  // sentence, audio streams out as it synthesizes and forwards byte-for-byte
  // (mulaw/8000 straight to the carrier — no resample, no adapter encode).
  tts = new WorkersAIRealtimeTTS(this.env.AI);
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

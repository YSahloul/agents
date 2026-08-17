import { Agent, routeAgentRequest } from "agents";
import {
  createVoiceAgent,
  WorkersAIFluxSTT,
  WorkersAIRealtimeTTS,
  type VoiceTurnContext
} from "@cloudflare/voice";
import { SignalWireAdapter } from "@cloudflare/voice-signalwire";
import { streamText } from "ai";
import { createWorkersAI } from "workers-ai-provider";

const MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
const SYSTEM_PROMPT = `You are a phone voice assistant. Respond in 1-2 short sentences. Be direct and natural. Never exceed 30 words unless asked for detail.`;

// Demo per-number config lookup — stand-in for a future D1 query.
const DEMO_CALL_CONFIGS = new Map<
  string,
  { systemPrompt: string; model: string }
>([
  [
    "+15555550100",
    {
      systemPrompt:
        "You are a phone voice assistant for Acme Plumbing. Respond in 1-2 short sentences. Be direct and natural.",
      model: MODEL
    }
  ]
]);

const VoiceAgent = createVoiceAgent(Agent, {
  filterEchoedTranscripts: true,
  listenDuringCallStart: false,
  stt: (env: Env) =>
    new WorkersAIFluxSTT(env.AI, {
      // Eager end-of-turn starts the LLM draft at 0.5, confirmed end-of-turn
      // releases it at 0.7, and resumed speech cancels it before any output.
      eagerEotThreshold: 0.5,
      eotThreshold: 0.7
    }),
  // WebSocket μ-law TTS (the rebuilt synthesizeStream path): one socket per
  // sentence, audio streams out as it synthesizes and forwards byte-for-byte
  // (mulaw/8000 straight to the carrier — no resample, no adapter encode).
  tts: (env: Env) => new WorkersAIRealtimeTTS(env.AI),
  greeting: "Hello! How can I help you today?"
});

export class MyVoiceAgent extends VoiceAgent<Env> {
  #workersAi = createWorkersAI({ binding: this.env.AI });

  async onTurn(transcript: string, context: VoiceTurnContext) {
    const systemPrompt =
      (this.callProps?.systemPrompt as string | undefined) ?? SYSTEM_PROMPT;
    const model = (this.callProps?.model as string | undefined) ?? MODEL;

    const result = streamText({
      model: this.#workersAi(model, {
        sessionAffinity: this.sessionAffinity
      }),
      system: systemPrompt,
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
            DEMO_CALL_CONFIGS.get(start.customParameters?.To ?? "")
        }
      );
    }

    return (
      (await routeAgentRequest(request, env)) ??
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;

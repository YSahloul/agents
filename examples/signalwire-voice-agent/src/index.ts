import { Agent, routeAgentRequest, type Connection } from "agents";
import {
  withVoice,
  WorkersAIFluxSTT,
  WorkersAIMulawRealtimeTTS,
  type VoiceTurnContext
} from "@cloudflare/voice";
import { SignalWireAdapter } from "@cloudflare/voice-signalwire";
import { streamText, tool } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { z } from "zod";

/** Stops the agent answering its own TTS, which the phone trunk loops back
 * into the mic. Local to this example — not a library concern. */
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

const SYSTEM_PROMPT = `You are a phone voice assistant. Respond in 1-2 short sentences. Be direct and natural. Never exceed 30 words unless asked for detail.`;

const VoiceAgent = withVoice(Agent);

export class MyVoiceAgent extends VoiceAgent<Env> {
  transcriber = new WorkersAIFluxSTT(this.env.AI, {
    eagerEotThreshold: 0.5,
    eotThreshold: 0.7
  });
  tts = new WorkersAIMulawRealtimeTTS(this.env.AI);
  #workersAi = createWorkersAI({ binding: this.env.AI });

  async onCallStart(connection: Connection) {
    await this.speak(connection, "Hello! How can I help you today?");
  }

  async onTurn(transcript: string, context: VoiceTurnContext) {
    const result = streamText({
      model: this.#workersAi("@cf/openai/gpt-oss-20b", {
        sessionAffinity: this.sessionAffinity
      }),
      system: SYSTEM_PROMPT,
      messages: [
        ...context.messages.slice(-6).map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content
        })),
        { role: "user" as const, content: transcript }
      ],
      maxOutputTokens: 150,
      tools: {
        get_current_time: tool({
          description: "Get the current date and time.",
          inputSchema: z.object({}),
          execute: async () => {
            const now = new Date();
            return {
              time: now.toLocaleTimeString("en-US", {
                hour: "2-digit",
                minute: "2-digit",
                timeZoneName: "short"
              }),
              date: now.toLocaleDateString("en-US", {
                weekday: "long",
                year: "numeric",
                month: "long",
                day: "numeric"
              })
            };
          }
        })
      }
    });

    return result.fullStream;
  }
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

import { WorkersAITTS, type TTSProvider } from "@cloudflare/voice";

export function createWorkersAITTS(env: Env, url: URL): TTSProvider {
  return new WorkersAITTS(env.AI, {
    model: "@cf/deepgram/aura-2-en",
    speaker: url.searchParams.get("ttsSpeaker") || "draco",
    encoding: "linear16",
    container: "none",
    sampleRate: 24000
  });
}

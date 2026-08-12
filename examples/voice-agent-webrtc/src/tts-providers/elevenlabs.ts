import type { StreamingTTSProvider, TTSProvider } from "@cloudflare/voice";
import { ElevenLabsTTS } from "@cloudflare/voice-elevenlabs";
import { getEnvString } from "./utils";

const ELEVENLABS_MODELS = new Set([
  "eleven_flash_v2_5",
  "eleven_multilingual_v2"
]);

export function createElevenLabsTTS(
  env: Env,
  url: URL
): TTSProvider & StreamingTTSProvider {
  const apiKey = getEnvString(env, "ELEVENLABS_API_KEY");
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY is not configured.");

  const voiceId = url.searchParams.get("ttsVoiceId")?.trim();
  const modelId = url.searchParams.get("ttsModel");

  return new ElevenLabsTTS({
    apiKey,
    ...(voiceId && /^[A-Za-z0-9_-]{1,100}$/.test(voiceId) && { voiceId }),
    ...(modelId && ELEVENLABS_MODELS.has(modelId) && { modelId }),
    outputFormat: "pcm_24000"
  });
}

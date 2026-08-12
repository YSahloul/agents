import type { StreamingTTSProvider, TTSProvider } from "@cloudflare/voice";
import type { Connection } from "agents";
import { createElevenLabsTTS } from "./tts-providers/elevenlabs";
import type { TtsProvider } from "./tts-providers/types";
import { getEnvString } from "./tts-providers/utils";

export function createElevenLabsVoiceTTS(
  connection: Connection,
  env: Env
): (TTSProvider & StreamingTTSProvider) | null {
  const url = new URL(connection.uri ?? "http://localhost");
  return getTtsProvider(url) === "elevenlabs"
    ? createElevenLabsTTS(env, url)
    : null;
}

export function getMissingTtsProviderKey(
  connection: Connection,
  env: Env
): string | null {
  const url = new URL(connection.uri ?? "http://localhost");
  if (
    getTtsProvider(url) === "elevenlabs" &&
    !getEnvString(env, "ELEVENLABS_API_KEY")
  ) {
    return "ElevenLabs TTS requires ELEVENLABS_API_KEY in your .env file or Worker secrets.";
  }
  return null;
}

function getTtsProvider(url: URL): TtsProvider {
  return url.searchParams.get("tts") === "elevenlabs"
    ? "elevenlabs"
    : "workers-ai";
}

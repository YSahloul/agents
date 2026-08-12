import { Surface } from "@cloudflare/kumo";
import {
  ElevenLabsSettings,
  getElevenLabsQuery
} from "./tts-settings/elevenlabs";
import type { TtsProvider, TtsSettings } from "./tts-settings/types";
import {
  getWorkersAIQuery,
  WorkersAISettings
} from "./tts-settings/workers-ai";

export type { TtsSettings } from "./tts-settings/types";

export const DEFAULT_TTS_SETTINGS: TtsSettings = {
  provider: "workers-ai",
  workersAiSpeaker: "draco",
  elevenlabsVoiceId: "",
  elevenlabsModel: "eleven_flash_v2_5"
};

export function getTtsQuery(settings: TtsSettings): Record<string, string> {
  return settings.provider === "elevenlabs"
    ? getElevenLabsQuery(settings)
    : getWorkersAIQuery(settings);
}

export function TtsProviderSettings({
  settings,
  disabled,
  onChange
}: {
  settings: TtsSettings;
  disabled: boolean;
  onChange: (settings: TtsSettings) => void;
}) {
  const update = (patch: Partial<TtsSettings>) => {
    onChange({ ...settings, ...patch });
  };

  return (
    <Surface className="rounded-xl p-3 ring ring-kumo-line">
      <label className="flex flex-col gap-2 text-xs text-kumo-secondary">
        TTS provider
        <select
          aria-label="Text-to-speech provider"
          value={settings.provider}
          disabled={disabled}
          onChange={(event) =>
            update({ provider: event.target.value as TtsProvider })
          }
          className="w-full rounded-lg border border-kumo-line bg-kumo-base px-3 py-2 text-sm text-kumo-default"
        >
          <option value="workers-ai">Workers AI Aura 2</option>
          <option value="elevenlabs">ElevenLabs</option>
        </select>
      </label>

      <details className="mt-3 rounded-lg border border-kumo-line p-3">
        <summary className="cursor-pointer text-xs text-kumo-secondary">
          Provider settings
        </summary>
        <div className="mt-3 flex flex-col gap-3">
          {settings.provider === "workers-ai" ? (
            <WorkersAISettings
              settings={settings}
              disabled={disabled}
              update={update}
            />
          ) : (
            <ElevenLabsSettings
              settings={settings}
              disabled={disabled}
              update={update}
            />
          )}
        </div>
      </details>
    </Surface>
  );
}

import type { SettingsUpdate, TtsSettings } from "./types";

export function getElevenLabsQuery(
  settings: TtsSettings
): Record<string, string> {
  return {
    tts: "elevenlabs",
    ttsModel: settings.elevenlabsModel,
    ...(settings.elevenlabsVoiceId.trim() && {
      ttsVoiceId: settings.elevenlabsVoiceId.trim()
    })
  };
}

export function ElevenLabsSettings({
  settings,
  disabled,
  update
}: {
  settings: TtsSettings;
  disabled: boolean;
  update: SettingsUpdate;
}) {
  return (
    <>
      <label className="flex flex-col gap-1 text-xs text-kumo-secondary">
        Voice ID
        <input
          value={settings.elevenlabsVoiceId}
          disabled={disabled}
          placeholder="George (default)"
          onChange={(event) =>
            update({ elevenlabsVoiceId: event.target.value })
          }
          className="rounded-lg border border-kumo-line bg-kumo-base px-3 py-2 text-sm text-kumo-default"
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-kumo-secondary">
        Model
        <select
          value={settings.elevenlabsModel}
          disabled={disabled}
          onChange={(event) =>
            update({
              elevenlabsModel: event.target
                .value as TtsSettings["elevenlabsModel"]
            })
          }
          className="rounded-lg border border-kumo-line bg-kumo-base px-3 py-2 text-sm text-kumo-default"
        >
          <option value="eleven_flash_v2_5">Flash v2.5</option>
          <option value="eleven_multilingual_v2">Multilingual v2</option>
        </select>
      </label>
    </>
  );
}

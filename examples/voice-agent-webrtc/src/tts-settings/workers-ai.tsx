import type { SettingsUpdate, TtsSettings } from "./types";

export function getWorkersAIQuery(
  settings: TtsSettings
): Record<string, string> {
  return {
    tts: "workers-ai",
    ttsSpeaker: settings.workersAiSpeaker.trim() || "draco"
  };
}

export function WorkersAISettings({
  settings,
  disabled,
  update
}: {
  settings: TtsSettings;
  disabled: boolean;
  update: SettingsUpdate;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs text-kumo-secondary">
      Aura speaker
      <input
        value={settings.workersAiSpeaker}
        disabled={disabled}
        placeholder="draco"
        onChange={(event) => update({ workersAiSpeaker: event.target.value })}
        className="rounded-lg border border-kumo-line bg-kumo-base px-3 py-2 text-sm text-kumo-default"
      />
    </label>
  );
}

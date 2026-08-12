export type TtsProvider = "workers-ai" | "elevenlabs";

export type TtsSettings = {
  provider: TtsProvider;
  elevenlabsVoiceId: string;
  elevenlabsModel: "eleven_flash_v2_5" | "eleven_multilingual_v2";
};

export type SettingsUpdate = (patch: Partial<TtsSettings>) => void;

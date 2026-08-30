import { describe, expect, it } from "vitest";
import * as packageEntry from "../index";
import * as implementation from "../voice";

describe("public package entry", () => {
  it("exports the combined parent and optional voice surface", () => {
    for (const name of [
      "withVoice",
      "withSFUVoice",
      "withSFUVoiceTransport",
      "SFUVoiceTransport",
      "streamRpcVoiceTurn",
      "convertTTSProvider",
      "WorkersAIRealtimeTTS",
      "WorkersAIGrokTTS",
      "WorkersAIFluxSTT"
    ]) {
      expect(packageEntry).toHaveProperty(name);
    }
  });

  it("keeps SFU composition out of the voice implementation", () => {
    expect(implementation).not.toHaveProperty("withSFUVoice");
  });
});

import { describe, expect, it } from "vitest";
import {
  convertTTSProvider,
  mp3ToPcm16,
  StreamingMp3ToPcm16
} from "../audio-converters";

const MP3_44K_STEREO =
  "SUQzBAAAAAAAIlRTU0UAAAAOAAADTGF2ZjYzLjEuMTAxAAAAAAAAAAAAAAD/+xBkAAAAeQbThTAACgAADSCgAAEECDNKGaEAAAAANIMAAAASxLM4zgQAQBoTH7tvh4eXmEPCUBWlYAow1gGGg8RdG2F1xoav/3woD4CDXCoK/YpwBuAAY4xmY0Y/o4xWHZVTU2QcP//7EmQKA/CPBtWnYAAIAAANIOAAAQIgG0y1oAAgAAA0goAABHTzDoGmimdArrdeJxuN5wALwwwwwAAAAMhQlMOeaCY3Fd9E0ukxne79/N5ZP4GFfx4sXwMd+FVHAwCJa5EiRsiRRYbF6f/7EGQbAAFDENXOYKAAAAANIMAAAAGsGz4cYAAoAAA0g4AABExBTUU0LjBVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV";

function fixture(): Uint8Array {
  return Uint8Array.from(atob(MP3_44K_STEREO), (char) => char.charCodeAt(0));
}

describe("StreamingMp3ToPcm16", () => {
  it("preserves an MP3's native sample rate and channels", async () => {
    const converter = await StreamingMp3ToPcm16.create();
    const mp3 = fixture();
    const split = Math.floor(mp3.byteLength / 2);
    const chunks = [
      converter.push(mp3.subarray(0, split)),
      converter.push(mp3.subarray(split)),
      converter.finish()
    ].filter((chunk) => chunk !== null);

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((chunk) => chunk.sampleRate === 44100)).toBe(true);
    expect(chunks.every((chunk) => chunk.channels === 2)).toBe(true);
    expect(
      chunks.some((chunk) => chunk.audio.some((sample) => sample !== 0))
    ).toBe(true);
  });

  it("normalizes arbitrary MP3 audio to a requested PCM format", async () => {
    const converter = await StreamingMp3ToPcm16.create({
      sampleRate: 16000,
      channels: 1
    });
    const first = converter.push(fixture());
    const last = converter.finish();
    const chunks = [first, last].filter((chunk) => chunk !== null);

    expect(chunks.every((chunk) => chunk.sampleRate === 16000)).toBe(true);
    expect(chunks.every((chunk) => chunk.channels === 1)).toBe(true);
    expect(
      chunks.reduce((bytes, chunk) => bytes + chunk.audio.byteLength, 0) % 2
    ).toBe(0);
  });
});

describe("convertTTSProvider", () => {
  it("composes a provider and converter through configuration", async () => {
    const provider = {
      audioFormat: "mp3" as const,
      async synthesize(): Promise<ArrayBuffer> {
        return fixture().slice().buffer;
      },
      async *synthesizeStream(): AsyncGenerator<ArrayBuffer> {
        const mp3 = fixture();
        const split = Math.floor(mp3.byteLength / 2);
        yield mp3.slice(0, split).buffer;
        yield mp3.slice(split).buffer;
      }
    };
    const tts = convertTTSProvider({
      provider,
      converter: mp3ToPcm16({ sampleRate: 16000 })
    });

    expect(tts.audioFormat).toBe("pcm16");
    expect(tts.sampleRate).toBe(16000);

    const streamed: Uint8Array[] = [];
    for await (const chunk of tts.synthesizeStream("hello")) {
      streamed.push(new Uint8Array(chunk));
    }
    expect(streamed.length).toBeGreaterThan(0);
    expect(streamed.some((chunk) => chunk.some((sample) => sample !== 0))).toBe(
      true
    );

    const batch = await tts.synthesize("hello");
    expect(batch?.byteLength).toBeGreaterThan(0);
  });

  it("rejects a converter for the wrong provider format", () => {
    expect(() =>
      convertTTSProvider({
        provider: {
          audioFormat: "opus",
          synthesize: async () => null
        },
        converter: mp3ToPcm16({ sampleRate: 24000 })
      })
    ).toThrow("TTS provider emits opus; converter expects mp3");
  });
});

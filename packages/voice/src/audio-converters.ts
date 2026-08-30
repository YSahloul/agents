import { Decoder as Mp3Decoder } from "minimp3-wasm";
import * as mp3DecoderModule from "minimp3-wasm/dist/decoder.opt.wasm";

import type {
  StreamingTextTTSProvider,
  StreamingTTSProvider,
  TTSProvider,
  VoiceAudioFormat
} from "./types";

export interface Mp3ToPcm16Options {
  /** Output sample rate. Preserve the MP3 sample rate when omitted. */
  sampleRate?: number;
  /** Output channel count. Preserve the MP3 channel count when omitted. */
  channels?: 1 | 2;
}

export interface Pcm16Chunk {
  audio: Uint8Array;
  sampleRate: number;
  channels: number;
}

export interface AudioChunkConverter {
  push(chunk: Uint8Array): Uint8Array | null;
  finish(): Uint8Array | null;
}

export interface AudioConverter {
  readonly inputFormat: VoiceAudioFormat;
  readonly outputFormat: VoiceAudioFormat;
  readonly sampleRate?: number;
  createStream(): Promise<AudioChunkConverter>;
}

export interface Mp3ToPcm16ConverterOptions {
  sampleRate: number;
}

export interface ConvertTTSProviderOptions {
  provider: TTSProvider;
  converter: AudioConverter;
}

export type ConvertedTTSProvider = TTSProvider &
  StreamingTTSProvider &
  Partial<StreamingTextTTSProvider>;

function normalizePcm16(
  input: Int16Array,
  inputRate: number,
  inputChannels: number,
  outputRate: number,
  outputChannels: number,
  final: boolean
): Int16Array {
  const inputFrames = Math.floor(input.length / inputChannels);
  if (inputFrames === 0) return new Int16Array();

  const completeOutputFrames = Math.floor(
    (inputFrames * outputRate) / inputRate
  );
  const outputFrames = final
    ? completeOutputFrames
    : Math.min(
        completeOutputFrames,
        Math.ceil(((inputFrames - 1) * outputRate) / inputRate)
      );
  const output = new Int16Array(outputFrames * outputChannels);
  const ratio = inputRate / outputRate;

  const sampleAt = (frame: number, channel: number): number => {
    if (outputChannels === 1) {
      let sum = 0;
      for (let i = 0; i < inputChannels; i++) {
        sum += input[frame * inputChannels + i] ?? 0;
      }
      return sum / inputChannels;
    }
    if (inputChannels === 1) return input[frame] ?? 0;
    return input[frame * inputChannels + channel] ?? 0;
  };

  for (let frame = 0; frame < outputFrames; frame++) {
    const sourceIndex = frame * ratio;
    const low = Math.floor(sourceIndex);
    const high = Math.min(low + 1, inputFrames - 1);
    const fraction = sourceIndex - low;
    for (let channel = 0; channel < outputChannels; channel++) {
      output[frame * outputChannels + channel] = Math.round(
        sampleAt(low, channel) * (1 - fraction) +
          sampleAt(high, channel) * fraction
      );
    }
  }

  return output;
}

/**
 * Incrementally decodes an MP3 byte stream to signed little-endian PCM16.
 *
 * Each instance handles one MP3 stream. It can preserve the MP3's native
 * sample rate and channel count or normalize both for a transport.
 */
export class StreamingMp3ToPcm16 {
  #chunks: Uint8Array[] = [];
  #byteLength = 0;
  #emittedSamples = 0;
  #finished = false;
  #inputRate: number | undefined;
  #inputChannels: number | undefined;
  #outputRate: number | undefined;
  #outputChannels: number | undefined;

  private constructor(
    private readonly wasm: WebAssembly.Exports,
    private readonly options: Mp3ToPcm16Options
  ) {}

  private static isWasmExports(value: object): value is WebAssembly.Exports {
    return (
      "memory" in value &&
      value.memory instanceof WebAssembly.Memory &&
      "decoder_init" in value
    );
  }

  static async create(
    options: Mp3ToPcm16Options = {}
  ): Promise<StreamingMp3ToPcm16> {
    if (
      options.sampleRate !== undefined &&
      (!Number.isInteger(options.sampleRate) || options.sampleRate <= 0)
    ) {
      throw new Error("MP3 PCM output sampleRate must be a positive integer");
    }
    const embeddedModule: unknown =
      "default" in mp3DecoderModule ? mp3DecoderModule.default : undefined;
    const wasm =
      embeddedModule instanceof WebAssembly.Module
        ? (await WebAssembly.instantiate(embeddedModule, {})).exports
        : StreamingMp3ToPcm16.isWasmExports(mp3DecoderModule)
          ? mp3DecoderModule
          : null;
    if (!wasm) throw new Error("MP3 decoder module did not expose WebAssembly");
    return new StreamingMp3ToPcm16(wasm, options);
  }

  push(chunk: Uint8Array): Pcm16Chunk | null {
    if (this.#finished) {
      throw new Error("Cannot push MP3 data after finishing the stream");
    }
    if (chunk.byteLength === 0) return null;
    this.#chunks.push(chunk);
    this.#byteLength += chunk.byteLength;
    return this.#decode(false);
  }

  finish(): Pcm16Chunk | null {
    if (this.#finished) return null;
    this.#finished = true;
    return this.#decode(true);
  }

  #decode(final: boolean): Pcm16Chunk | null {
    if (this.#byteLength === 0) return null;
    const mp3 = new Uint8Array(this.#byteLength);
    let offset = 0;
    for (const buffered of this.#chunks) {
      mp3.set(buffered, offset);
      offset += buffered.byteLength;
    }

    // ponytail: Voice utterances are short, so re-decoding the buffered stream
    // keeps the decoder stateless. Use a stateful decoder if profiling shows
    // long-form audio makes this too expensive.
    const result = new Mp3Decoder(this.wasm, mp3).decode(
      Number.POSITIVE_INFINITY
    );
    if (
      result.samplingRate === 0 ||
      result.numChannels === 0 ||
      result.numSamples === 0
    ) {
      return null;
    }

    if (
      (this.#inputRate !== undefined &&
        this.#inputRate !== result.samplingRate) ||
      (this.#inputChannels !== undefined &&
        this.#inputChannels !== result.numChannels)
    ) {
      throw new Error("MP3 stream changed its sample rate or channel count");
    }
    this.#inputRate = result.samplingRate;
    this.#inputChannels = result.numChannels;
    this.#outputRate ??= this.options.sampleRate ?? result.samplingRate;
    this.#outputChannels ??= this.options.channels ?? result.numChannels;

    const normalized = normalizePcm16(
      result.pcm,
      this.#inputRate,
      this.#inputChannels,
      this.#outputRate,
      this.#outputChannels,
      final
    );
    if (normalized.length <= this.#emittedSamples) return null;

    const audio = new Uint8Array(
      normalized.buffer,
      this.#emittedSamples * Int16Array.BYTES_PER_ELEMENT
    ).slice();
    this.#emittedSamples = normalized.length;
    return {
      audio,
      sampleRate: this.#outputRate,
      channels: this.#outputChannels
    };
  }
}

/** Configure reusable MP3-to-mono-PCM16 conversion for provider composition. */
export function mp3ToPcm16(
  options: Mp3ToPcm16ConverterOptions
): AudioConverter {
  return {
    inputFormat: "mp3",
    outputFormat: "pcm16",
    sampleRate: options.sampleRate,
    async createStream(): Promise<AudioChunkConverter> {
      const converter = await StreamingMp3ToPcm16.create({
        sampleRate: options.sampleRate,
        channels: 1
      });
      return {
        push: (chunk) => converter.push(chunk)?.audio ?? null,
        finish: () => converter.finish()?.audio ?? null
      };
    }
  };
}

function hasStreamingAudio(
  provider: TTSProvider
): provider is TTSProvider & StreamingTTSProvider {
  return (
    "synthesizeStream" in provider &&
    typeof provider.synthesizeStream === "function"
  );
}

function hasStreamingText(
  provider: TTSProvider
): provider is TTSProvider & StreamingTextTTSProvider {
  return (
    "synthesizeTextStream" in provider &&
    typeof provider.synthesizeTextStream === "function"
  );
}

async function* convertAudio(
  source: AsyncIterable<ArrayBuffer>,
  converter: AudioConverter
): AsyncGenerator<ArrayBuffer> {
  const stream = await converter.createStream();
  for await (const chunk of source) {
    const converted = stream.push(new Uint8Array(chunk));
    if (converted) yield converted.slice().buffer;
  }
  const final = stream.finish();
  if (final) yield final.slice().buffer;
}

async function* oneChunk(
  audio: Promise<ArrayBuffer | null>
): AsyncGenerator<ArrayBuffer> {
  const chunk = await audio;
  if (chunk) yield chunk;
}

async function collectAudio(
  source: AsyncIterable<ArrayBuffer>
): Promise<ArrayBuffer | null> {
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  for await (const chunk of source) {
    const bytes = new Uint8Array(chunk);
    chunks.push(bytes);
    byteLength += bytes.byteLength;
  }
  if (chunks.length === 0) return null;
  const output = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output.buffer;
}

/**
 * Wrap any TTS provider with an injected audio converter.
 *
 * A fresh converter stream is created for every synthesis call, so providers
 * remain stateless and concurrent calls do not share codec state.
 */
export function convertTTSProvider({
  provider,
  converter
}: ConvertTTSProviderOptions): ConvertedTTSProvider {
  if (
    provider.audioFormat !== undefined &&
    provider.audioFormat !== converter.inputFormat
  ) {
    throw new Error(
      `TTS provider emits ${provider.audioFormat}; converter expects ${converter.inputFormat}`
    );
  }

  const converted: ConvertedTTSProvider = {
    audioFormat: converter.outputFormat,
    sampleRate: converter.sampleRate,
    synthesize: (text, signal) =>
      collectAudio(
        convertAudio(
          hasStreamingAudio(provider)
            ? provider.synthesizeStream(text, signal)
            : oneChunk(provider.synthesize(text, signal)),
          converter
        )
      ),
    synthesizeStream: (text, signal) =>
      convertAudio(
        hasStreamingAudio(provider)
          ? provider.synthesizeStream(text, signal)
          : oneChunk(provider.synthesize(text, signal)),
        converter
      )
  };

  if (hasStreamingText(provider)) {
    converted.synthesizeTextStream = (text, signal) =>
      convertAudio(provider.synthesizeTextStream(text, signal), converter);
  }
  return converted;
}

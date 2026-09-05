import { decodeMulaw, encodeMulaw } from "./utils.js";

export interface AmbientMixerOptions {
  /** Raw G.711 μ-law, 8 kHz, mono audio, looped continuously. */
  audio: Uint8Array;
  /** Mix level from 0 to 1. Defaults to 0.15. */
  volume?: number;
}

function encodeSamples(samples: Int16Array): Uint8Array {
  const output = new Uint8Array(samples.length);
  for (let index = 0; index < samples.length; index++) {
    output[index] = encodeMulaw(samples[index]);
  }
  return output;
}

/** Mixes a looping ambient recording into final carrier μ-law audio. */
export class AmbientMixer {
  private readonly audio: Int16Array;
  private readonly volume: number;
  private position = 0;

  constructor({ audio, volume = 0.15 }: AmbientMixerOptions) {
    this.audio = decodeMulaw(audio);
    this.volume = Math.max(0, Math.min(1, volume));
  }

  get enabled(): boolean {
    return this.audio.length > 0 && this.volume > 0;
  }

  mix(audio: Uint8Array): Uint8Array {
    if (!this.enabled) return audio;
    const output = decodeMulaw(audio);
    this.mixInto(output);
    return encodeSamples(output);
  }

  silence(samples: number): Uint8Array {
    const output = new Int16Array(samples);
    if (this.enabled) this.mixInto(output);
    return encodeSamples(output);
  }

  private mixInto(output: Int16Array): void {
    for (let index = 0; index < output.length; index++) {
      if (this.position === this.audio.length) this.position = 0;
      const mixed = output[index] + this.audio[this.position] * this.volume;
      output[index] = Math.max(-32768, Math.min(32767, mixed)) | 0;
      this.position++;
    }
  }
}

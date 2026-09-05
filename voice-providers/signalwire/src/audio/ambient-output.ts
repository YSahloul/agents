import { AmbientMixer } from "./ambient-mixer.js";

const FRAME_BYTES = 160;
const FRAME_MS = 20;

export interface AmbientPlaybackMarker {
  type: "playback_marker";
  playbackId: string;
  sequence: number;
  text: string;
}

type QueueEntry =
  | { type: "audio"; audio: Uint8Array }
  | { type: "marker"; marker: AmbientPlaybackMarker };

export interface AmbientOutputOptions {
  audio: Uint8Array;
  volume?: number;
  sendAudio(audio: Uint8Array): void;
  sendMarker(
    marker: AmbientPlaybackMarker,
    metrics: { frames: number; bytes: number }
  ): void;
}

/** Owns the single continuous 20 ms carrier-audio clock when ambience is enabled. */
export class AmbientOutput {
  private readonly mixer: AmbientMixer;
  private readonly sendAudio: AmbientOutputOptions["sendAudio"];
  private readonly sendMarker: AmbientOutputOptions["sendMarker"];
  private readonly queue: QueueEntry[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private frames = 0;
  private bytes = 0;

  constructor(options: AmbientOutputOptions) {
    this.mixer = new AmbientMixer(options);
    this.sendAudio = options.sendAudio;
    this.sendMarker = options.sendMarker;
  }

  get enabled(): boolean {
    return this.mixer.enabled;
  }

  start(): void {
    if (!this.enabled || this.timer) return;
    this.timer = setInterval(() => this.tick(), FRAME_MS);
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.clear();
  }

  clear(): void {
    this.queue.length = 0;
    this.frames = 0;
    this.bytes = 0;
  }

  enqueueAudio(audio: Uint8Array): void {
    for (let offset = 0; offset < audio.length; offset += FRAME_BYTES) {
      const source = audio.subarray(offset, offset + FRAME_BYTES);
      if (source.length === FRAME_BYTES) {
        this.queue.push({ type: "audio", audio: source.slice() });
      } else {
        const frame = new Uint8Array(FRAME_BYTES).fill(0xff);
        frame.set(source);
        this.queue.push({ type: "audio", audio: frame });
      }
    }
  }

  enqueueMarker(marker: AmbientPlaybackMarker): boolean {
    if (this.frames === 0 && !this.queue.some((entry) => entry.type === "audio")) {
      return false;
    }
    this.queue.push({ type: "marker", marker });
    return true;
  }

  resetMetrics(): void {
    this.frames = 0;
    this.bytes = 0;
  }

  private tick(): void {
    while (this.queue[0]?.type === "marker") {
      const entry = this.queue.shift();
      if (!entry || entry.type !== "marker") break;
      this.sendMarker(entry.marker, { frames: this.frames, bytes: this.bytes });
      this.resetMetrics();
    }

    const entry = this.queue.shift();
    if (entry?.type === "audio") {
      const audio = this.mixer.mix(entry.audio);
      this.sendAudio(audio);
      this.frames++;
      this.bytes += audio.length;
      return;
    }

    this.sendAudio(this.mixer.silence(FRAME_BYTES));
  }
}

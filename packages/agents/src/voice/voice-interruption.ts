import type { VoiceAudioFormat } from "./types";

export function isEchoOf(transcript: string, assistantText: string): boolean {
  if (!assistantText) return false;
  const assistant =
    assistantText
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu)
      ?.join(" ") ?? "";
  const heard = transcript.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (heard.length >= 3 && assistant.includes(heard.join(" "))) return true;
  const assistantWords = new Set(assistant.split(" "));
  const hits = heard.filter((word) => assistantWords.has(word)).length;
  return hits >= 4 && hits / heard.length >= 0.6;
}

type PlaybackSegment = {
  text: string;
  aligned: boolean;
  complete: boolean;
  chunks: Array<{ start: number; ms: number }>;
};

/** Keeps `fraction` of `text`, dropping a word cut in half. */
function cutToWholeWords(text: string, fraction: number): string {
  const n = Math.floor(text.length * fraction);
  if (n >= text.length) return text.trim();
  const head = text.slice(0, n);
  return (
    /\s/.test(text[n]) ? head : head.slice(0, head.search(/\S*$/))
  ).trim();
}

/**
 * Virtual playback clock for one assistant reply. Audio is assumed to play in
 * real time from the moment it is sent, back to back, as the telephony
 * adapters pace it. Maps played time to the text the listener heard.
 */
export class PlaybackTimeline {
  #segments: PlaybackSegment[] = [];
  #current: PlaybackSegment | null = null;
  #playEnd = 0;
  readonly #msPerByte: number;

  private constructor(msPerByte: number) {
    this.#msPerByte = msPerByte;
  }

  /** Null for encoded formats (mp3, wav, opus): duration cannot be derived from bytes. */
  static forFormat(
    format: VoiceAudioFormat,
    sampleRate: number
  ): PlaybackTimeline | null {
    if (!(sampleRate > 0)) return null;
    if (format === "pcm16")
      return new PlaybackTimeline(1000 / (sampleRate * 2));
    if (format === "mulaw") return new PlaybackTimeline(1000 / sampleRate);
    return null;
  }

  /** Starts a text segment (one sentence, or a whole reply) whose audio follows. */
  begin(text: string): void {
    this.#current = { text, aligned: false, complete: false, chunks: [] };
    this.#segments.push(this.#current);
  }

  /** Records `bytes` of audio sent at `now`. Word-timed chunks pass their own text. */
  add(bytes: number, now: number, alignedText?: string): void {
    const ms = bytes * this.#msPerByte;
    const start = Math.max(now, this.#playEnd);
    this.#playEnd = start + ms;
    if (alignedText !== undefined) {
      this.#segments.push({
        text: alignedText,
        aligned: true,
        complete: true,
        chunks: [{ start, ms }]
      });
      return;
    }
    if (!this.#current) this.begin("");
    this.#current?.chunks.push({ start, ms });
  }

  /** Marks the current segment's audio complete; `text` replaces its text when given. */
  end(text?: string): void {
    if (!this.#current) return;
    if (text !== undefined) this.#current.text = text;
    this.#current.complete = true;
    this.#current = null;
  }

  isPlaying(now: number): boolean {
    return now < this.#playEnd;
  }

  heardText(now: number): string {
    let heard = "";
    for (const segment of this.#segments) {
      if (segment.chunks.length === 0) continue;
      let total = 0;
      let played = 0;
      for (const { start, ms } of segment.chunks) {
        total += ms;
        played += Math.min(ms, Math.max(0, now - start));
      }
      const fully = segment.complete && played >= total;
      if (!fully && (segment.aligned || !segment.complete)) break;
      const part = fully
        ? segment.text
        : cutToWholeWords(segment.text, played / total);
      heard = segment.aligned
        ? heard + part
        : [heard.trimEnd(), part.trim()].filter(Boolean).join(" ");
      if (!fully) break;
    }
    return heard.trim();
  }
}

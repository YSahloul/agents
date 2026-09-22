/**
 * Sentence chunker — accumulates streaming text and yields speech-ready chunks.
 *
 * By default it emits complete sentences. A finite `maxChunkLength` also emits
 * bounded phrases at clause or word boundaries, allowing TTS to start while a
 * long sentence is still being generated.
 *
 * Isolated and testable: no dependencies on the voice pipeline, Agent, or AI
 * APIs. Feed it tokens via `add()`, get back chunks via the return value. Call
 * `flush()` at end-of-stream to get any remaining text.
 */

const SENTENCE_TERMINATORS: Record<string, true> = {
  ".": true,
  "!": true,
  "?": true
};
const CLAUSE_TERMINATORS: Record<string, true> = {
  ",": true,
  ";": true,
  ":": true,
  "—": true
};

/**
 * Minimum character count before we'll emit a sentence.
 * Prevents emitting fragments like "Dr." or "U.S." as standalone sentences,
 * while still allowing short responses like "Sure thing!" to stream quickly.
 */
const MIN_SENTENCE_LENGTH = 10;
const MIN_PHRASE_LENGTH = 24;

export class SentenceChunker {
  #buffer = "";

  /**
   * @param maxChunkLength Maximum phrase length. Omit to split only sentences.
   */
  constructor(private readonly maxChunkLength = Number.POSITIVE_INFINITY) {}
  /**
   * Add a chunk of text (e.g. a streamed LLM token).
   * Returns an array of complete sentences extracted from the buffer.
   * May return 0, 1, or multiple sentences depending on the input.
   */
  add(text: string): string[] {
    this.#buffer += text;
    return this.#extractSentences();
  }

  /**
   * Flush any remaining text in the buffer as a final sentence.
   * Call this when the LLM stream ends.
   * Returns the remaining text (trimmed), or an empty array if nothing is left.
   */
  flush(): string[] {
    const remaining = this.#buffer.trim();
    this.#buffer = "";
    if (remaining.length > 0) {
      return [remaining];
    }
    return [];
  }

  /**
   * Reset the chunker, discarding any buffered text.
   */
  reset() {
    this.#buffer = "";
  }

  /** Extract every speech-ready chunk currently buffered. */
  #extractSentences(): string[] {
    const sentences: string[] = [];

    while (true) {
      const boundary = this.#findSentenceBoundary();
      if (boundary === -1) break;

      const sentence = this.#buffer.slice(0, boundary + 1).trim();
      this.#buffer = this.#buffer.slice(boundary + 1).trimStart();

      if (sentence.length > 0) {
        sentences.push(sentence);
      }
    }

    return sentences;
  }

  /** Return the inclusive end index of the next speech-ready chunk. */
  #findSentenceBoundary(): number {
    let sentenceBoundary = -1;
    for (let i = 0; i < this.#buffer.length; i++) {
      const char = this.#buffer[i];
      if (!SENTENCE_TERMINATORS[char]) continue;

      const nextChar = this.#buffer[i + 1];
      const candidate = this.#buffer.slice(0, i + 1).trim();
      if (
        candidate.length >= MIN_SENTENCE_LENGTH &&
        (nextChar === " " || nextChar === "\n")
      ) {
        sentenceBoundary = i;
        break;
      }
      if (
        nextChar === undefined &&
        Number.isFinite(this.maxChunkLength) &&
        candidate.length <= this.maxChunkLength &&
        candidate.length >= MIN_SENTENCE_LENGTH
      ) {
        sentenceBoundary = i;
        break;
      }
    }

    if (
      sentenceBoundary !== -1 &&
      sentenceBoundary + 1 <= this.maxChunkLength
    ) {
      return sentenceBoundary;
    }
    if (this.#buffer.length < this.maxChunkLength) return -1;

    const limit = Math.min(this.maxChunkLength - 1, this.#buffer.length - 1);
    for (let i = limit; i >= MIN_PHRASE_LENGTH; i--) {
      const char = this.#buffer[i];
      if (
        CLAUSE_TERMINATORS[char] &&
        (this.#buffer[i + 1] === " " ||
          this.#buffer[i + 1] === "\n" ||
          this.#buffer[i + 1] === undefined)
      ) {
        return i;
      }
    }
    for (let i = limit; i >= MIN_PHRASE_LENGTH; i--) {
      if (this.#buffer[i] === " " || this.#buffer[i] === "\n") {
        return i - 1;
      }
    }
    return -1;
  }
}

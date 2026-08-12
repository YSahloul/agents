/**
 * Workers AI provider implementations for the voice pipeline.
 *
 * These are convenience classes that wrap the Workers AI binding
 * (env.AI) for STT and TTS. They are not required — any object
 * satisfying the provider interfaces works.
 */

import type {
  StreamingTTSProvider,
  TTSProvider,
  Transcriber,
  TranscriberSession,
  TranscriberSessionOptions,
  VoiceAudioFormat
} from "./types";

// --- Loose AI binding type ---

/** Loose type for the Workers AI binding — avoids hard dependency on @cloudflare/workers-types. */
interface AiLike {
  run(
    model: string,
    input: Record<string, unknown>,
    options?: Record<string, unknown>
  ): Promise<unknown>;
}

// --- TTS ---

export interface WorkersAITTSOptions {
  /** TTS model name. @default "@cf/deepgram/aura-1" */
  model?: string;
  /** TTS speaker voice. @default "asteria" */
  speaker?: string;
  /** Output audio encoding. */
  encoding?: "linear16" | "flac" | "mulaw" | "alaw" | "mp3" | "opus" | "aac";
  /** Output audio container. */
  container?: "none" | "wav" | "ogg";
  /** Output audio sample rate in Hz. */
  sampleRate?: number;
}

/**
 * Workers AI text-to-speech provider.
 *
 * @example
 * ```ts
 * class MyAgent extends VoiceAgent<Env> {
 *   tts = new WorkersAITTS(this.env.AI);
 * }
 * ```
 */
export class WorkersAITTS implements TTSProvider {
  #ai: AiLike;
  #model: string;
  #speaker: string;
  #encoding: WorkersAITTSOptions["encoding"];
  #container: WorkersAITTSOptions["container"];
  #sampleRate: number | undefined;

  constructor(ai: AiLike, options?: WorkersAITTSOptions) {
    this.#ai = ai;
    this.#model = options?.model ?? "@cf/deepgram/aura-1";
    this.#speaker = options?.speaker ?? "asteria";
    this.#encoding = options?.encoding;
    this.#container = options?.container;
    this.#sampleRate = options?.sampleRate;
  }

  async synthesize(
    text: string,
    signal?: AbortSignal
  ): Promise<ArrayBuffer | null> {
    const input: Record<string, unknown> = {
      text,
      speaker: this.#speaker
    };
    if (this.#encoding !== undefined) input.encoding = this.#encoding;
    if (this.#container !== undefined) input.container = this.#container;
    if (this.#sampleRate !== undefined) input.sample_rate = this.#sampleRate;
    const response = (await this.#ai.run(this.#model, input, {
      returnRawResponse: true,
      ...(signal ? { signal } : {})
    })) as Response;

    // Without this check an error body (e.g. a 429 quota JSON) would be
    // forwarded to the client as audio bytes and fail to decode silently.
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.error(
        `[WorkersAITTS] TTS request failed: HTTP ${response.status}${body ? ` — ${body.slice(0, 200)}` : ""}`
      );
      return null;
    }

    return await response.arrayBuffer();
  }
}

export type WorkersAIRealtimeTTSOptions = {
  /** TTS model name. @default "@cf/deepgram/aura-2-en" */
  model?: string;
  /** TTS speaker voice. @default "asteria" */
  speaker?: string;
} & (
  | { encoding?: "mulaw"; sampleRate?: 8000 }
  | { encoding: "linear16"; sampleRate?: 24000 }
);

/**
 * Workers AI text-to-speech over the binding's native WebSocket mode
 * (`env.AI.run(model, input, { websocket: true })`).
 *
 * Implements {@link StreamingTTSProvider}: one socket per sentence, and the
 * generator returning *is* completion. Interruption is the consumer abandoning
 * the iterator (or aborting the signal), which closes the socket.
 *
 * Inherits {@link WorkersAITTS.synthesize} as the non-streaming fallback.
 *
 * @example
 * ```ts
 * class MyAgent extends VoiceAgent<Env> {
 *   tts = new WorkersAIRealtimeTTS(this.env.AI);
 * }
 * ```
 */
export class WorkersAIRealtimeTTS
  extends WorkersAITTS
  implements StreamingTTSProvider
{
  readonly audioFormat: VoiceAudioFormat;
  readonly sampleRate: number;
  #ai: AiLike;
  #model: string;
  #speaker: string;
  #encoding: "mulaw" | "linear16";

  constructor(ai: AiLike, options?: WorkersAIRealtimeTTSOptions) {
    const model = options?.model ?? "@cf/deepgram/aura-2-en";
    const speaker = options?.speaker ?? "asteria";
    const encoding = options?.encoding ?? "mulaw";
    const sampleRate =
      options?.sampleRate ?? (encoding === "mulaw" ? 8000 : 24000);
    if (
      !(
        (encoding === "mulaw" && sampleRate === 8000) ||
        (encoding === "linear16" && sampleRate === 24000)
      )
    ) {
      throw new Error(
        "Workers AI realtime TTS supports only mulaw/8000 or linear16/24000"
      );
    }
    super(ai, {
      model,
      speaker,
      encoding,
      sampleRate,
      container: "none"
    });
    this.audioFormat = encoding === "mulaw" ? "mulaw" : "pcm16";
    this.sampleRate = sampleRate;
    this.#ai = ai;
    this.#model = model;
    this.#speaker = speaker;
    this.#encoding = encoding;
  }

  async *synthesizeStream(
    text: string,
    signal?: AbortSignal
  ): AsyncGenerator<ArrayBuffer> {
    if (!text || signal?.aborted) return;

    const ws = await this.#open();
    const sampleBytes = this.#encoding === "mulaw" ? 1 : 2;
    const frameBytes = (this.sampleRate * FRAME_MS * sampleBytes) / 1000;
    const frames = new AudioFrameStream(frameBytes, sampleBytes);

    ws.addEventListener("message", (event: MessageEvent) => {
      if (typeof event.data === "string") {
        try {
          const message: unknown = JSON.parse(event.data);
          if (
            message &&
            typeof message === "object" &&
            "type" in message &&
            message.type === "Flushed"
          ) {
            frames.finish();
          }
        } catch {
          // Ignore malformed control messages.
        }
        return;
      }
      // binaryType is pinned to "arraybuffer" in #open, so audio arrives as
      // an ArrayBuffer and can be appended without a microtask gap.
      if (event.data instanceof ArrayBuffer) {
        frames.push(new Uint8Array(event.data));
      } else if (ArrayBuffer.isView(event.data)) {
        const view = event.data as ArrayBufferView;
        frames.push(
          new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
        );
      }
    });
    ws.addEventListener("close", (event: CloseEvent) => {
      frames.fail(
        new Error(
          `Workers AI realtime TTS socket closed before flush (code ${event.code}${
            event.reason ? `: ${event.reason}` : ""
          })`
        )
      );
    });
    ws.addEventListener("error", () => {
      frames.fail(new Error("Workers AI realtime TTS socket error"));
    });

    try {
      ws.send(JSON.stringify({ type: "Speak", text, speaker: this.#speaker }));
      ws.send(JSON.stringify({ type: "Flush" }));

      // Real-time pacing: one 20 ms frame every 20 ms, first frame
      // immediately. Without it a whole utterance lands at the transport at
      // once — which an RTP track cannot absorb, and which leaves seconds of
      // audio queued downstream that a barge-in then has to claw back.
      let nextYieldAt = 0;
      for await (const frame of frames) {
        if (signal?.aborted) return;
        const now = Date.now();
        if (nextYieldAt === 0) {
          nextYieldAt = now + FRAME_MS;
        } else {
          if (now < nextYieldAt) {
            await new Promise<void>((resolve) =>
              setTimeout(resolve, nextYieldAt - now)
            );
          }
          nextYieldAt = Math.max(nextYieldAt + FRAME_MS, Date.now() + FRAME_MS);
        }
        yield frame;
      }
    } finally {
      try {
        ws.close();
      } catch {
        // Already closed.
      }
    }
  }

  async #open(): Promise<WebSocket> {
    const response = await this.#ai.run(
      this.#model,
      {
        encoding: this.#encoding,
        sample_rate: String(this.sampleRate),
        speaker: this.#speaker,
        container: "none"
      },
      { websocket: true }
    );
    if (
      !response ||
      typeof response !== "object" ||
      !("webSocket" in response) ||
      !isWebSocket(response.webSocket)
    ) {
      throw new Error("Workers AI realtime TTS did not return a WebSocket");
    }
    const ws = response.webSocket;
    ws.accept();
    ws.binaryType = "arraybuffer";
    return ws;
  }
}

const FRAME_MS = 20;

/**
 * Bridges the TTS socket's arbitrary fragments into fixed-duration audio
 * frames, with any complete-sample remainder emitted on `Flushed`.
 */
class AudioFrameStream {
  #frame: Uint8Array;
  #frameLength = 0;
  #queue: ArrayBuffer[] = [];
  #done = false;
  #error: Error | null = null;
  #wake: (() => void) | null = null;

  constructor(
    private readonly frameBytes: number,
    private readonly sampleBytes: 1 | 2
  ) {
    this.#frame = new Uint8Array(frameBytes);
  }

  push(chunk: Uint8Array): void {
    if (this.#done) return;
    let offset = 0;
    while (offset < chunk.byteLength) {
      const copied = Math.min(
        this.frameBytes - this.#frameLength,
        chunk.byteLength - offset
      );
      this.#frame.set(
        chunk.subarray(offset, offset + copied),
        this.#frameLength
      );
      this.#frameLength += copied;
      offset += copied;
      if (this.#frameLength === this.frameBytes) {
        this.#queue.push(this.#frame.buffer as ArrayBuffer);
        this.#frame = new Uint8Array(this.frameBytes);
        this.#frameLength = 0;
      }
    }
    this.#notify();
  }

  /** Server acknowledged the flush: emit the partial frame and end. */
  finish(): void {
    if (this.#done) return;
    if (this.#frameLength % this.sampleBytes !== 0) {
      this.fail(
        new Error("Workers AI realtime TTS returned incomplete linear16 sample")
      );
      return;
    }
    if (this.#frameLength > 0) {
      this.#queue.push(this.#frame.slice(0, this.#frameLength).buffer);
      this.#frameLength = 0;
    }
    this.#done = true;
    this.#notify();
  }

  /** Socket died before the flush was acknowledged. No-op once ended. */
  fail(error: Error): void {
    if (this.#done) return;
    this.#error = error;
    this.#done = true;
    this.#notify();
  }

  #notify(): void {
    const wake = this.#wake;
    this.#wake = null;
    wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<ArrayBuffer> {
    while (true) {
      while (this.#queue.length > 0) yield this.#queue.shift() as ArrayBuffer;
      if (this.#error) throw this.#error;
      if (this.#done) return;
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
    }
  }
}

function isWebSocket(value: unknown): value is WebSocket {
  return (
    !!value &&
    typeof value === "object" &&
    "accept" in value &&
    typeof value.accept === "function" &&
    "send" in value &&
    typeof value.send === "function" &&
    "addEventListener" in value &&
    typeof value.addEventListener === "function"
  );
}

// --- Flux continuous STT ---

export interface WorkersAIFluxSTTOptions {
  /** End-of-turn confidence threshold (0.5-0.9). @default 0.7 */
  eotThreshold?: number;
  /**
   * Eager end-of-turn threshold (0.3-0.9). When set, enables
   * EagerEndOfTurn and TurnResumed events for speculative processing.
   */
  eagerEotThreshold?: number;
  /** EOT timeout in milliseconds. @default 5000 */
  eotTimeoutMs?: number;
  /** Keyterms to boost recognition of specialized terminology. */
  keyterms?: string[];
  /** Sample rate in Hz. @default 16000 */
  sampleRate?: number;
}

/**
 * Workers AI continuous speech-to-text provider using the Flux model.
 *
 * Flux is a conversational STT model with built-in end-of-turn detection.
 * A single session is created per call and receives all audio continuously.
 * The model detects speech boundaries and fires `onUtterance` when a
 * turn is complete — no client-side silence detection needed for STT.
 *
 * Recommended for `withVoice` (conversational voice agents).
 *
 * @example
 * ```ts
 * import { Agent } from "agents";
 * import { withVoice, WorkersAIFluxSTT, WorkersAITTS } from "@cloudflare/voice";
 *
 * const VoiceAgent = withVoice(Agent);
 *
 * class MyAgent extends VoiceAgent<Env> {
 *   transcriber = new WorkersAIFluxSTT(this.env.AI);
 *   tts = new WorkersAITTS(this.env.AI);
 *
 *   async onTurn(transcript, context) { ... }
 * }
 * ```
 */
export class WorkersAIFluxSTT implements Transcriber {
  #ai: AiLike;
  #sampleRate: number;
  #eotThreshold: number | undefined;
  #eagerEotThreshold: number | undefined;
  #eotTimeoutMs: number | undefined;
  #keyterms: string[] | undefined;

  constructor(ai: AiLike, options?: WorkersAIFluxSTTOptions) {
    this.#ai = ai;
    this.#sampleRate = options?.sampleRate ?? 16000;
    this.#eotThreshold = options?.eotThreshold;
    this.#eagerEotThreshold = options?.eagerEotThreshold;
    this.#eotTimeoutMs = options?.eotTimeoutMs;
    this.#keyterms = options?.keyterms;
  }

  createSession(options?: TranscriberSessionOptions): TranscriberSession {
    return new FluxSession(
      this.#ai,
      {
        sampleRate: this.#sampleRate,
        eotThreshold: this.#eotThreshold,
        eagerEotThreshold: this.#eagerEotThreshold,
        eotTimeoutMs: this.#eotTimeoutMs,
        keyterms: this.#keyterms
      },
      options
    );
  }
}

interface FluxSessionConfig {
  sampleRate: number;
  eotThreshold?: number;
  eagerEotThreshold?: number;
  eotTimeoutMs?: number;
  keyterms?: string[];
}

interface FluxEvent {
  event:
    | "Update"
    | "StartOfTurn"
    | "EagerEndOfTurn"
    | "TurnResumed"
    | "EndOfTurn";
  transcript?: string;
  end_of_turn_confidence?: number;
}

/**
 * Per-call Flux transcription session. Lives for the entire call.
 *
 * Handles multi-turn conversations: on EndOfTurn, fires onUtterance
 * and resets transcript state for the next turn. On StartOfTurn,
 * clears accumulated text. The session stays alive across turns
 * and is only closed on end_call or disconnect.
 */
class FluxSession implements TranscriberSession {
  #onInterim: ((text: string) => void) | undefined;
  #onSpeechStart: ((text?: string) => void) | undefined;
  #onUtterance: ((text: string) => void) | undefined;
  #onEagerUtterance: ((transcript: string) => void) | undefined;
  #onTurnResumed: ((transcript?: string) => void) | undefined;

  #ws: WebSocket | null = null;
  #connected = false;
  #closed = false;

  #pendingChunks: ArrayBuffer[] = [];
  #currentTranscript = "";

  #ready: Promise<void>;
  #resolveReady: (() => void) | null = null;
  #rejectReady: ((reason: unknown) => void) | null = null;

  constructor(
    ai: AiLike,
    config: FluxSessionConfig,
    options?: TranscriberSessionOptions
  ) {
    this.#onInterim = options?.onInterim;
    this.#onSpeechStart = options?.onSpeechStart;
    this.#onUtterance = options?.onUtterance;
    this.#onEagerUtterance = options?.onEagerUtterance;
    this.#onTurnResumed = options?.onTurnResumed;
    this.#ready = new Promise<void>((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
    this.#ready.catch(() => {});
    this.#connect(ai, config);
  }

  waitUntilReady(): Promise<void> {
    return this.#ready;
  }

  async #connect(ai: AiLike, config: FluxSessionConfig): Promise<void> {
    try {
      const input: Record<string, unknown> = {
        encoding: "linear16",
        sample_rate: String(config.sampleRate)
      };
      if (config.eotThreshold != null)
        input.eot_threshold = String(config.eotThreshold);
      if (config.eagerEotThreshold != null)
        input.eager_eot_threshold = String(config.eagerEotThreshold);
      if (config.eotTimeoutMs != null)
        input.eot_timeout_ms = String(config.eotTimeoutMs);
      if (config.keyterms?.length) input.keyterm = config.keyterms;

      const resp = await ai.run("@cf/deepgram/flux", input, {
        websocket: true
      });

      if (this.#closed) {
        const ws = (resp as { webSocket?: WebSocket }).webSocket;
        if (ws) {
          ws.accept();
          ws.close();
        }
        this.#resolveReadiness();
        return;
      }

      const ws = (resp as { webSocket?: WebSocket }).webSocket;
      if (!ws) {
        let message = "Workers AI Flux STT did not return a WebSocket";
        if (resp instanceof Response) {
          const body = await resp.text().catch(() => "");
          message = `Workers AI Flux STT failed: HTTP ${resp.status}${body ? ` — ${body.slice(0, 500)}` : ""}`;
        }
        const error = new Error(message);
        console.error("[FluxSTT] Failed to establish WebSocket:", error);
        this.#rejectReadiness(error);
        return;
      }

      ws.accept();
      this.#ws = ws;
      this.#connected = true;

      ws.addEventListener("message", (event: MessageEvent) => {
        this.#handleMessage(event);
      });

      ws.addEventListener("close", () => {
        this.#connected = false;
      });

      ws.addEventListener("error", (event: Event) => {
        console.error("[FluxSTT] WebSocket error:", event);
        this.#connected = false;
      });

      for (const chunk of this.#pendingChunks) {
        ws.send(chunk);
      }
      this.#pendingChunks = [];
      this.#resolveReadiness();
    } catch (err) {
      console.error("[FluxSTT] Connection error:", err);
      this.#rejectReadiness(err);
    }
  }

  feed(chunk: ArrayBuffer): void {
    if (this.#closed) return;

    if (this.#connected && this.#ws) {
      this.#ws.send(chunk);
    } else {
      this.#pendingChunks.push(chunk);
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#pendingChunks = [];
    if (this.#ws) {
      try {
        this.#ws.close();
      } catch {
        // ignore close errors
      }
      this.#ws = null;
    }
    this.#connected = false;
    this.#resolveReadiness();
  }

  #resolveReadiness(): void {
    const resolve = this.#resolveReady;
    if (!resolve) return;
    this.#resolveReady = null;
    this.#rejectReady = null;
    resolve();
  }

  #rejectReadiness(reason: unknown): void {
    const reject = this.#rejectReady;
    if (!reject) return;
    this.#resolveReady = null;
    this.#rejectReady = null;
    reject(reason);
  }

  #handleMessage(event: MessageEvent): void {
    if (this.#closed) return;

    try {
      const data: FluxEvent =
        typeof event.data === "string" ? JSON.parse(event.data) : null;

      if (!data || !data.event) return;

      const transcript = data.transcript ?? "";

      switch (data.event) {
        case "StartOfTurn":
          this.#currentTranscript = "";
          this.#onSpeechStart?.(transcript || undefined);
          if (transcript) {
            this.#currentTranscript = transcript;
            this.#onInterim?.(transcript);
          }
          break;

        case "Update":
          if (transcript) {
            this.#currentTranscript = transcript;
            this.#onInterim?.(transcript);
          }
          break;

        case "EndOfTurn": {
          const finalTranscript = transcript || this.#currentTranscript;
          this.#currentTranscript = "";
          if (finalTranscript) {
            this.#onUtterance?.(finalTranscript);
          }
          break;
        }

        case "EagerEndOfTurn":
          if (transcript) {
            this.#currentTranscript = transcript;
            this.#onInterim?.(transcript);
            this.#onEagerUtterance?.(transcript);
          }
          break;

        case "TurnResumed":
          this.#currentTranscript = transcript;
          if (transcript) {
            this.#onInterim?.(transcript);
          }
          this.#onTurnResumed?.(transcript || undefined);
          break;
      }
    } catch {
      // Ignore non-JSON or malformed messages
    }
  }
}

// --- Nova 3 continuous STT ---

export interface WorkersAINova3STTOptions {
  /** Language code. @default "en" */
  language?: string;
  /** Endpointing silence duration in ms. @default 300 */
  endpointingMs?: number;
  /** Utterance end detection timeout in ms. @default 1000 */
  utteranceEndMs?: number;
  /** Enable smart formatting (numbers, dates, etc.). @default true */
  smartFormat?: boolean;
  /** Enable punctuation. @default true */
  punctuate?: boolean;
  /** Keyterms to boost recognition of specialized terminology. */
  keyterms?: string[];
  /** Sample rate in Hz. @default 16000 */
  sampleRate?: number;
}

/**
 * Workers AI continuous speech-to-text provider using Nova 3.
 *
 * Nova 3 is a high-accuracy STT model with streaming WebSocket support.
 * A single session is created per call and receives all audio continuously.
 * Server-side VAD events and endpointing handle speech boundary detection.
 *
 * Recommended for `withVoiceInput` (dictation / voice input UIs).
 *
 * @example
 * ```ts
 * import { Agent } from "agents";
 * import { withVoiceInput, WorkersAINova3STT } from "@cloudflare/voice";
 *
 * const InputAgent = withVoiceInput(Agent);
 *
 * class MyAgent extends InputAgent<Env> {
 *   transcriber = new WorkersAINova3STT(this.env.AI);
 *
 *   onTranscript(text, connection) { ... }
 * }
 * ```
 */
export class WorkersAINova3STT implements Transcriber {
  #ai: AiLike;
  #sampleRate: number;
  #language: string;
  #endpointingMs: number;
  #utteranceEndMs: number;
  #smartFormat: boolean;
  #punctuate: boolean;
  #keyterms: string[] | undefined;

  constructor(ai: AiLike, options?: WorkersAINova3STTOptions) {
    this.#ai = ai;
    this.#sampleRate = options?.sampleRate ?? 16000;
    this.#language = options?.language ?? "en";
    this.#endpointingMs = options?.endpointingMs ?? 300;
    this.#utteranceEndMs = options?.utteranceEndMs ?? 1000;
    this.#smartFormat = options?.smartFormat ?? true;
    this.#punctuate = options?.punctuate ?? true;
    this.#keyterms = options?.keyterms;
  }

  createSession(options?: TranscriberSessionOptions): TranscriberSession {
    return new Nova3Session(
      this.#ai,
      {
        sampleRate: this.#sampleRate,
        language: this.#language,
        endpointingMs: this.#endpointingMs,
        utteranceEndMs: this.#utteranceEndMs,
        smartFormat: this.#smartFormat,
        punctuate: this.#punctuate,
        keyterms: this.#keyterms
      },
      options
    );
  }
}

interface Nova3SessionConfig {
  sampleRate: number;
  language: string;
  endpointingMs: number;
  utteranceEndMs: number;
  smartFormat: boolean;
  punctuate: boolean;
  keyterms?: string[];
}

interface Nova3Result {
  type: string;
  channel?: {
    alternatives?: Array<{
      transcript?: string;
    }>;
  };
  is_final?: boolean;
  speech_final?: boolean;
}

/**
 * Per-call Nova 3 transcription session. Lives for the entire call.
 *
 * Uses Nova 3's endpointing and VAD events to detect utterance
 * boundaries. When a result arrives with `speech_final: true`,
 * the accumulated finalized segments are emitted as an utterance.
 */
class Nova3Session implements TranscriberSession {
  #onSpeechStart: ((text?: string) => void) | undefined;
  #onInterim: ((text: string) => void) | undefined;
  #onUtterance: ((text: string) => void) | undefined;

  #ws: WebSocket | null = null;
  #connected = false;
  #closed = false;
  #speechStartPending = false;

  #pendingChunks: ArrayBuffer[] = [];

  #finalizedSegments: string[] = [];

  constructor(
    ai: AiLike,
    config: Nova3SessionConfig,
    options?: TranscriberSessionOptions
  ) {
    this.#onSpeechStart = options?.onSpeechStart;
    this.#onInterim = options?.onInterim;
    this.#onUtterance = options?.onUtterance;
    this.#connect(ai, config);
  }

  async #connect(ai: AiLike, config: Nova3SessionConfig): Promise<void> {
    try {
      const input: Record<string, unknown> = {
        encoding: "linear16",
        sample_rate: String(config.sampleRate),
        language: config.language,
        interim_results: "true",
        vad_events: "true",
        endpointing: String(config.endpointingMs),
        utterance_end_ms: String(config.utteranceEndMs),
        smart_format: String(config.smartFormat),
        punctuate: String(config.punctuate)
      };
      if (config.keyterms?.length) input.keyterm = config.keyterms;

      const resp = await ai.run("@cf/deepgram/nova-3", input, {
        websocket: true
      });

      if (this.#closed) {
        const ws = (resp as { webSocket?: WebSocket }).webSocket;
        if (ws) {
          ws.accept();
          ws.close();
        }
        return;
      }

      const ws = (resp as { webSocket?: WebSocket }).webSocket;
      if (!ws) {
        console.error("[Nova3STT] Failed to establish WebSocket connection");
        return;
      }

      ws.accept();
      this.#ws = ws;
      this.#connected = true;

      ws.addEventListener("message", (event: MessageEvent) => {
        this.#handleMessage(event);
      });

      ws.addEventListener("close", () => {
        this.#connected = false;
      });

      ws.addEventListener("error", (event: Event) => {
        console.error("[Nova3STT] WebSocket error:", event);
        this.#connected = false;
      });

      for (const chunk of this.#pendingChunks) {
        ws.send(chunk);
      }
      this.#pendingChunks = [];
    } catch (err) {
      console.error("[Nova3STT] Connection error:", err);
    }
  }

  feed(chunk: ArrayBuffer): void {
    if (this.#closed) return;

    if (this.#connected && this.#ws) {
      this.#ws.send(chunk);
    } else {
      this.#pendingChunks.push(chunk);
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#pendingChunks = [];
    if (this.#ws) {
      try {
        this.#ws.close();
      } catch {
        // ignore close errors
      }
      this.#ws = null;
    }
    this.#connected = false;
  }

  #handleMessage(event: MessageEvent): void {
    if (this.#closed) return;

    try {
      const data: Nova3Result =
        typeof event.data === "string" ? JSON.parse(event.data) : null;

      if (!data) return;
      if (data.type === "SpeechStarted") {
        this.#speechStartPending = true;
        return;
      }

      if (data.type === "Results") {
        // Defensive re-init: stale messages after abnormal teardown can observe
        // this field as undefined in some runtime edge cases. Keep normal
        // behavior unchanged while avoiding throws on late Results events.
        if (!this.#finalizedSegments) this.#finalizedSegments = [];

        const transcript = data.channel?.alternatives?.[0]?.transcript ?? "";
        if (this.#speechStartPending && transcript) {
          this.#speechStartPending = false;
          this.#onSpeechStart?.(transcript);
        }

        if (data.is_final && transcript) {
          this.#finalizedSegments.push(transcript);
        }

        if (data.speech_final) {
          this.#speechStartPending = false;
          const fullTranscript = (this.#finalizedSegments ?? [])
            .join(" ")
            .trim();
          this.#finalizedSegments = [];
          if (fullTranscript) {
            this.#onUtterance?.(fullTranscript);
          }
        } else if (!data.is_final && transcript) {
          const finalizedSegments = this.#finalizedSegments ?? [];
          const display =
            finalizedSegments.length > 0
              ? finalizedSegments.join(" ") + " " + transcript
              : transcript;
          this.#onInterim?.(display);
        }
      }
    } catch {
      // Ignore non-JSON or malformed messages
    }
  }
}

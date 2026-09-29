import type {
  StreamingTextTTSProvider,
  StreamingTTSProvider,
  TTSProvider,
  TTSStreamChunk,
  Transcriber,
  TranscriberSession,
  TranscriberSessionOptions
} from "agents/voice";
import {
  logVoiceError,
  toVoiceError,
  VoiceProviderError
} from "agents/voice/errors";

const DEFAULT_STT_MODEL_ID = "scribe_v2_realtime";
const DEFAULT_STT_AUDIO_FORMAT = "pcm_16000";
const DEFAULT_STT_SAMPLE_RATE = 16_000;
const DEFAULT_STT_BASE_URL =
  "wss://api.elevenlabs.io/v1/speech-to-text/realtime";
// About 30 seconds of 16 kHz mono PCM16 audio while the socket connects.
const MAX_PENDING_BYTES = 960_000;

export interface ElevenLabsTTSOptions {
  /** ElevenLabs API key. */
  apiKey: string;
  /** Voice ID. Browse voices at https://elevenlabs.io/app/voice-library @default "JBFqnCBsd6RMkjVDRZzb" (George) */
  voiceId?: string;
  /** Model ID. @default "eleven_flash_v2_5" (lowest latency) */
  modelId?: string;
  /** Output format. @default "mp3_44100_128" */
  outputFormat?: string;
  /** Include character alignment with Eleven v4 audio chunks. @default false */
  syncAlignment?: boolean;
}

export interface ElevenLabsSTTOptions {
  /** ElevenLabs API key. */
  apiKey: string;
  /** Realtime STT model ID. @default "scribe_v2_realtime" */
  modelId?: string;
  /** Audio format sent by the voice pipeline. @default "pcm_16000" */
  audioFormat?: string;
  /** Sample rate in Hz. @default 16000 */
  sampleRate?: number;
  /** Optional language code, e.g. "en" or "eng". */
  languageCode?: string;
  /** Bias recognition toward these terms. Realtime supports up to 50 terms. */
  keyterms?: string[];
  /** Remove filler words, false starts, and disfluencies. @default false */
  noVerbatim?: boolean;
  /** Filter background audio before transcription. @default false */
  filterBackgroundAudio?: boolean;
  /** Include language detection metadata on committed transcripts. @default false */
  includeLanguageDetection?: boolean;
  /** Disable provider-side logging where supported. @default true */
  enableLogging?: boolean;
  /** Silence threshold used by ElevenLabs VAD commit strategy. @default 1.5 */
  vadSilenceThresholdSecs?: number;
  /** VAD confidence threshold. @default 0.4 */
  vadThreshold?: number;
  /** Minimum speech duration in milliseconds. @default 100 */
  minSpeechDurationMs?: number;
  /** Minimum silence duration in milliseconds. @default 100 */
  minSilenceDurationMs?: number;
  /** Override the realtime WebSocket URL. */
  baseUrl?: string;
}

const DEFAULT_VOICE_ID = "JBFqnCBsd6RMkjVDRZzb"; // George
const DEFAULT_MODEL_ID = "eleven_flash_v2_5";
const DEFAULT_OUTPUT_FORMAT = "mp3_44100_128";
const TEXT_TO_DIALOGUE_STREAM_URL =
  "https://api.elevenlabs.io/v1/text-to-dialogue/stream-input";

/**
 * ElevenLabs text-to-speech provider for the Agents voice pipeline.
 *
 * Implements `TTSProvider` and `StreamingTTSProvider`. Eleven v4 models also
 * expose `StreamingTextTTSProvider` through the Text to Dialogue WebSocket.
 *
 * - `synthesize(text)` — waits for the complete audio response.
 * - `synthesizeStream(text)` — yields audio chunks as they are generated.
 * - `synthesizeTextStream(text)` — sends model text deltas directly to Eleven
 *   v4 and yields dialogue audio before the text stream completes.
 *
 * Set as the `tts` provider on your VoiceAgent subclass:
 *
 * @example
 * ```typescript
 * import { Agent } from "agents";
 * import { withVoice } from "agents/voice";
 * import { ElevenLabsTTS } from "@cloudflare/voice-elevenlabs";
 *
 * const VoiceAgent = withVoice(Agent);
 *
 * export class MyAgent extends VoiceAgent<Env> {
 *   tts = new ElevenLabsTTS({ apiKey: this.env.ELEVENLABS_API_KEY });
 *
 *   async onTurn(transcript, context) { ... }
 * }
 * ```
 */
export class ElevenLabsTTS implements TTSProvider, StreamingTTSProvider {
  #apiKey: string;
  #voiceId: string;
  #modelId: string;
  #outputFormat: string;
  #syncAlignment: boolean;
  readonly audioFormat?: "pcm16" | "mulaw" | "mp3" | "opus";
  readonly sampleRate?: number;
  readonly synthesizeTextStream?: StreamingTextTTSProvider["synthesizeTextStream"];

  constructor(options: ElevenLabsTTSOptions) {
    this.#apiKey = options.apiKey;
    this.#voiceId = options.voiceId ?? DEFAULT_VOICE_ID;
    this.#modelId = options.modelId ?? DEFAULT_MODEL_ID;
    this.#outputFormat = options.outputFormat ?? DEFAULT_OUTPUT_FORMAT;
    this.#syncAlignment = options.syncAlignment ?? false;
    if (this.#modelId.startsWith("eleven_v4")) {
      this.synthesizeTextStream = (text, signal) =>
        this.#synthesizeDialogueTextStream(text, signal);
    }

    const pcmMatch = /^pcm_(\d+)$/.exec(this.#outputFormat);
    const pcmSampleRate = pcmMatch ? Number(pcmMatch[1]) : 0;
    if (pcmSampleRate > 0) {
      this.audioFormat = "pcm16";
      this.sampleRate = pcmSampleRate;
    } else if (this.#outputFormat === "ulaw_8000") {
      this.audioFormat = "mulaw";
      this.sampleRate = 8000;
    } else if (this.#outputFormat.startsWith("mp3_")) {
      this.audioFormat = "mp3";
    } else if (this.#outputFormat.startsWith("opus_")) {
      this.audioFormat = "opus";
    }
  }

  /**
   * Non-streaming TTS — sends the full text and waits for the complete
   * audio response. Simple but higher latency per sentence.
   */
  async synthesize(
    text: string,
    signal?: AbortSignal
  ): Promise<ArrayBuffer | null> {
    if (this.#modelId.startsWith("eleven_v4")) {
      const chunks: ArrayBuffer[] = [];
      let byteLength = 0;
      for await (const chunk of this.synthesizeStream(text, signal)) {
        const audioChunk = chunk instanceof ArrayBuffer ? chunk : chunk.audio;
        chunks.push(audioChunk);
        byteLength += audioChunk.byteLength;
      }
      if (signal?.aborted) return null;
      if (chunks.length === 0) return null;
      const audio = new Uint8Array(byteLength);
      let offset = 0;
      for (const chunk of chunks) {
        audio.set(new Uint8Array(chunk), offset);
        offset += chunk.byteLength;
      }
      return audio.buffer;
    }

    try {
      const response = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${this.#voiceId}?output_format=${this.#outputFormat}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "xi-api-key": this.#apiKey
          },
          body: JSON.stringify({
            text,
            model_id: this.#modelId
          }),
          signal
        }
      );

      if (!response.ok) {
        logVoiceError({
          component: "ElevenLabsTTS",
          stage: "synthesize",
          message: "ElevenLabs TTS request failed",
          error: new VoiceProviderError("ElevenLabs TTS request failed", {
            status: response.status
          })
        });
        return null;
      }

      return await response.arrayBuffer();
    } catch (error) {
      logVoiceError({
        component: "ElevenLabsTTS",
        stage: "synthesize",
        message: "ElevenLabs TTS request failed",
        error: toVoiceError(error, "ElevenLabs TTS request failed")
      });
      return null;
    }
  }

  /**
   * Streaming TTS. Eleven v4 uses the Text to Dialogue WebSocket; other
   * models use the HTTP `/stream` endpoint.
   */
  async *synthesizeStream(
    text: string,
    signal?: AbortSignal
  ): AsyncGenerator<TTSStreamChunk> {
    if (this.#modelId.startsWith("eleven_v4")) {
      const source = new ReadableStream<string>({
        start(controller) {
          controller.enqueue(text);
          controller.close();
        }
      });
      yield* this.#synthesizeDialogueTextStream(source, signal);
      return;
    }

    try {
      const response = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${this.#voiceId}/stream?output_format=${this.#outputFormat}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "xi-api-key": this.#apiKey
          },
          body: JSON.stringify({
            text,
            model_id: this.#modelId
          }),
          signal
        }
      );

      if (!response.ok || !response.body) {
        logVoiceError({
          component: "ElevenLabsTTS",
          stage: "synthesize_stream",
          message: "ElevenLabs TTS stream request failed",
          error: new VoiceProviderError(
            "ElevenLabs TTS stream request failed",
            { status: response.status }
          )
        });
        return;
      }

      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          // value is a Uint8Array — yield the underlying ArrayBuffer slice
          yield value.buffer.slice(
            value.byteOffset,
            value.byteOffset + value.byteLength
          );
        }
      }
    } catch (error) {
      logVoiceError({
        component: "ElevenLabsTTS",
        stage: "synthesize_stream",
        message: "ElevenLabs TTS stream failed",
        error: toVoiceError(error, "ElevenLabs TTS stream failed")
      });
    }
  }
  async *#synthesizeDialogueTextStream(
    text: ReadableStream<string>,
    signal?: AbortSignal
  ): AsyncGenerator<TTSStreamChunk> {
    if (signal?.aborted) return;

    const url = new URL(TEXT_TO_DIALOGUE_STREAM_URL);
    url.searchParams.set("model_id", this.#modelId);
    url.searchParams.set("output_format", this.#outputFormat);
    if (this.#syncAlignment) {
      url.searchParams.set("sync_alignment", "true");
    }
    const response = await fetch(url, {
      headers: {
        Upgrade: "websocket",
        "xi-api-key": this.#apiKey
      },
      signal
    });
    const upgradedResponse = response as unknown as {
      webSocket?: WebSocket;
    };
    const ws = upgradedResponse.webSocket;
    if (!ws) {
      throw new VoiceProviderError(
        "ElevenLabs Text to Dialogue WebSocket upgrade failed",
        { status: response.status }
      );
    }
    ws.accept();

    let controller!: ReadableStreamDefaultController<TTSStreamChunk>;
    let settled = false;
    const audio = new ReadableStream<TTSStreamChunk>({
      start(value) {
        controller = value;
      }
    });
    const finish = () => {
      if (settled) return;
      settled = true;
      controller.close();
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      controller.error(error);
    };

    ws.addEventListener("message", (event: MessageEvent) => {
      if (settled) return;
      if (typeof event.data !== "string") return;
      let message: unknown;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!isObject(message)) return;
      if (typeof message.audio === "string") {
        const audioChunk = base64ToArrayBuffer(message.audio);
        const text = alignmentText(message.alignment);
        controller.enqueue(
          this.#syncAlignment && text !== null
            ? { audio: audioChunk, text }
            : audioChunk
        );
      }
      if (message.is_final === true) {
        finish();
      } else if (
        typeof message.error === "string" ||
        typeof message.code === "number"
      ) {
        fail(
          new VoiceProviderError("ElevenLabs Text to Dialogue failed", {
            code: typeof message.error === "string" ? message.error : undefined,
            closeCode:
              typeof message.code === "number" ? message.code : undefined
          })
        );
      }
    });
    ws.addEventListener("error", () => {
      fail(new Error("ElevenLabs Text to Dialogue WebSocket error"));
    });
    ws.addEventListener("close", (event: CloseEvent) => {
      if (settled || signal?.aborted) return;
      fail(
        new VoiceProviderError(
          "ElevenLabs Text to Dialogue WebSocket closed before completion",
          {
            closeCode: event.code,
            closeReason: event.reason,
            wasClean: event.wasClean
          }
        )
      );
    });

    const reader = text.getReader();
    const abort = () => {
      void reader.cancel(signal?.reason).catch(() => undefined);
      finish();
      try {
        ws.close();
      } catch {
        // Already closed.
      }
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();

    const input = (async () => {
      ws.send(JSON.stringify({ voices: [this.#voiceId] }));
      while (!signal?.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        ws.send(
          JSON.stringify({
            inputs: [
              {
                text: value,
                voice_id: this.#voiceId,
                new_turn: false
              }
            ]
          })
        );
      }
      if (!signal?.aborted) {
        ws.send(JSON.stringify({ close_socket: true }));
      }
    })().catch((error: unknown) => {
      if (!signal?.aborted) {
        fail(toVoiceError(error, "ElevenLabs dialogue input failed"));
      }
    });

    const audioReader = audio.getReader();
    try {
      while (true) {
        const { done, value } = await audioReader.read();
        if (done) break;
        yield value;
      }
      await input;
    } finally {
      signal?.removeEventListener("abort", abort);
      void reader.cancel().catch(() => undefined);
      void audioReader.cancel().catch(() => undefined);
      try {
        ws.close();
      } catch {
        // Already closed.
      }
    }
  }
}

function alignmentText(value: unknown): string | null {
  if (
    !isObject(value) ||
    !Array.isArray(value.chars) ||
    !value.chars.every((character) => typeof character === "string")
  ) {
    return null;
  }
  return value.chars.join("");
}

function base64ToArrayBuffer(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * ElevenLabs Scribe v2 Realtime speech-to-text provider for the Agents voice
 * pipeline. Uses ElevenLabs' VAD commit strategy so committed transcript
 * segments map to voice-agent turns.
 */
export class ElevenLabsSTT implements Transcriber {
  #options: ElevenLabsSTTOptions;

  constructor(options: ElevenLabsSTTOptions) {
    this.#options = options;
  }

  createSession(options?: TranscriberSessionOptions): TranscriberSession {
    return new ElevenLabsSTTSession(this.#options, options);
  }
}

class ElevenLabsSTTSession implements TranscriberSession {
  #providerOptions: ElevenLabsSTTOptions;
  #sessionOptions: TranscriberSessionOptions | undefined;
  #ws: WebSocket | null = null;
  #closed = false;
  #fatalReported = false;
  #ready: Promise<void>;
  #readyResolve!: () => void;
  #readyReject!: (error: Error) => void;
  #readySettled = false;
  #pendingChunks: ArrayBuffer[] = [];
  #pendingBytes = 0;
  #pendingOverflowLogged = false;
  #speechStarted = false;

  constructor(
    providerOptions: ElevenLabsSTTOptions,
    sessionOptions?: TranscriberSessionOptions
  ) {
    this.#providerOptions = providerOptions;
    this.#sessionOptions = sessionOptions;
    this.#ready = new Promise((resolve, reject) => {
      this.#readyResolve = resolve;
      this.#readyReject = reject;
    });
    this.#ready.catch(() => {});
    void this.#connect();
  }

  waitUntilReady(): Promise<void> {
    return this.#ready;
  }

  feed(chunk: ArrayBuffer): void {
    if (this.#closed) return;
    if (!this.#ws) {
      if (this.#pendingBytes + chunk.byteLength > MAX_PENDING_BYTES) {
        if (!this.#pendingOverflowLogged) {
          this.#pendingOverflowLogged = true;
          logVoiceError({
            component: "ElevenLabsSTT",
            stage: "audio_buffer",
            message: "ElevenLabs pending audio buffer full",
            error: new Error("Dropping audio until the socket connects")
          });
        }
        return;
      }
      this.#pendingBytes += chunk.byteLength;
      this.#pendingChunks.push(chunk);
      return;
    }
    this.#sendAudioChunk(chunk);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#rejectReady(
      new Error("ElevenLabsSTT: WebSocket closed before session start.")
    );
    this.#pendingChunks = [];
    this.#pendingBytes = 0;
    this.#ws?.close();
    this.#ws = null;
  }

  async #connect(): Promise<void> {
    try {
      const response = await fetch(this.#connectionUrl(), {
        headers: {
          Upgrade: "websocket",
          "xi-api-key": this.#providerOptions.apiKey
        }
      });

      const ws = (response as unknown as { webSocket?: WebSocket }).webSocket;
      if (!ws) {
        throw new VoiceProviderError(
          "ElevenLabs STT WebSocket upgrade failed",
          { status: response.status }
        );
      }

      ws.addEventListener("message", (event: MessageEvent) => {
        this.#handleMessage(event);
      });
      ws.addEventListener("error", (event: Event) => {
        const error = new Error("ElevenLabsSTT: WebSocket error.", {
          cause: event
        });
        this.#reportFatal(error);
        this.#rejectReady(error);
        this.#closed = true;
      });
      ws.addEventListener("close", (event: CloseEvent) => {
        if (this.#closed) return;
        const error = new VoiceProviderError(
          "ElevenLabsSTT: WebSocket closed before session start.",
          {
            closeCode: event.code,
            closeReason: event.reason,
            wasClean: event.wasClean
          }
        );
        this.#reportFatal(error);
        this.#rejectReady(error);
        this.#closed = true;
      });

      (ws as unknown as { accept: () => void }).accept();

      if (this.#closed) {
        ws.close();
        return;
      }

      this.#ws = ws;
      for (const chunk of this.#pendingChunks) {
        this.#sendAudioChunk(chunk);
      }
      this.#pendingChunks = [];
      this.#pendingBytes = 0;
    } catch (error) {
      const voiceError = toVoiceError(
        error,
        "ElevenLabs STT connection failed"
      );
      logVoiceError({
        component: "ElevenLabsSTT",
        stage: "connection",
        message: "ElevenLabs STT connection failed",
        error: voiceError
      });
      this.#reportFatal(voiceError);
      this.#rejectReady(voiceError);
      this.#closed = true;
    }
  }

  #resolveReady(): void {
    if (this.#readySettled) return;
    this.#readySettled = true;
    this.#readyResolve();
  }

  #rejectReady(error: Error): void {
    if (this.#readySettled) return;
    this.#readySettled = true;
    this.#readyReject(error);
  }

  #reportFatal(error: Error): void {
    if (this.#closed || this.#fatalReported) return;
    this.#fatalReported = true;
    this.#sessionOptions?.onFatalError?.(error);
  }

  #connectionUrl(): string {
    const url = new URL(
      (this.#providerOptions.baseUrl ?? DEFAULT_STT_BASE_URL)
        .replace(/^wss:\/\//, "https://")
        .replace(/^ws:\/\//, "http://")
    );
    url.searchParams.set(
      "model_id",
      this.#providerOptions.modelId ?? DEFAULT_STT_MODEL_ID
    );
    url.searchParams.set(
      "audio_format",
      this.#providerOptions.audioFormat ?? DEFAULT_STT_AUDIO_FORMAT
    );
    url.searchParams.set("commit_strategy", "vad");
    url.searchParams.set(
      "vad_silence_threshold_secs",
      String(this.#providerOptions.vadSilenceThresholdSecs ?? 1.5)
    );
    url.searchParams.set(
      "vad_threshold",
      String(this.#providerOptions.vadThreshold ?? 0.4)
    );
    url.searchParams.set(
      "min_speech_duration_ms",
      String(this.#providerOptions.minSpeechDurationMs ?? 100)
    );
    url.searchParams.set(
      "min_silence_duration_ms",
      String(this.#providerOptions.minSilenceDurationMs ?? 100)
    );
    if (this.#providerOptions.languageCode) {
      url.searchParams.set("language_code", this.#providerOptions.languageCode);
    }
    if (this.#providerOptions.noVerbatim !== undefined) {
      url.searchParams.set(
        "no_verbatim",
        String(this.#providerOptions.noVerbatim)
      );
    }
    if (this.#providerOptions.filterBackgroundAudio !== undefined) {
      url.searchParams.set(
        "filter_background_audio",
        String(this.#providerOptions.filterBackgroundAudio)
      );
    }
    if (this.#providerOptions.includeLanguageDetection !== undefined) {
      url.searchParams.set(
        "include_language_detection",
        String(this.#providerOptions.includeLanguageDetection)
      );
    }
    if (this.#providerOptions.enableLogging !== undefined) {
      url.searchParams.set(
        "enable_logging",
        String(this.#providerOptions.enableLogging)
      );
    }
    for (const keyterm of this.#providerOptions.keyterms ?? []) {
      url.searchParams.append("keyterms", keyterm);
    }
    return url.toString();
  }

  #sendAudioChunk(chunk: ArrayBuffer): void {
    try {
      this.#ws?.send(
        JSON.stringify({
          message_type: "input_audio_chunk",
          audio_base_64: arrayBufferToBase64(chunk),
          commit: false,
          sample_rate:
            this.#providerOptions.sampleRate ?? DEFAULT_STT_SAMPLE_RATE
        })
      );
    } catch (error) {
      if (!this.#closed) {
        logVoiceError({
          component: "ElevenLabsSTT",
          stage: "websocket_send",
          message: "ElevenLabs WebSocket send failed",
          error: toVoiceError(error, "ElevenLabs WebSocket send failed")
        });
      }
    }
  }

  #handleMessage(event: MessageEvent): void {
    if (this.#closed || typeof event.data !== "string") return;

    let data: unknown;
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }

    if (!isObject(data)) return;
    const messageType = data.message_type;
    if (messageType === "session_started") {
      this.#resolveReady();
      return;
    }

    if (messageType === "partial_transcript") {
      const text = stringProp(data, "text");
      if (text) {
        if (!this.#speechStarted) {
          this.#speechStarted = true;
          this.#sessionOptions?.onSpeechStart?.(text);
        }
        this.#sessionOptions?.onInterim?.(text);
      }
      return;
    }

    if (
      messageType === "committed_transcript" ||
      messageType === "committed_transcript_with_timestamps"
    ) {
      this.#speechStarted = false;
      const text = stringProp(data, "text");
      if (text) {
        this.#sessionOptions?.onUtterance?.(text);
      }
      return;
    }

    if (typeof messageType === "string" && messageType.includes("error")) {
      const error = new VoiceProviderError("ElevenLabs server error", {
        code: messageType
      });
      logVoiceError({
        component: "ElevenLabsSTT",
        stage: "provider_message",
        message: "ElevenLabs server error",
        error
      });
      this.#reportFatal(error);
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringProp(
  value: Record<string, unknown>,
  key: string
): string | undefined {
  const prop = value[key];
  return typeof prop === "string" ? prop : undefined;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

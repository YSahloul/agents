/**
 * Voice pipeline mixin for the Agents SDK.
 *
 * Usage:
 *   import { Agent } from "agents";
 *   import { withVoice, WorkersAIFluxSTT, WorkersAITTS } from "@cloudflare/voice";
 *
 *   const VoiceAgent = withVoice(Agent);
 *
 *   class MyAgent extends VoiceAgent<Env> {
 *     transcriber = new WorkersAIFluxSTT(this.env.AI);
 *     tts = new WorkersAITTS(this.env.AI);
 *
 *     async onTurn(transcript, context) {
 *       const result = streamText({ ... });
 *       return result.fullStream;
 *     }
 *   }
 *
 * This mixin adds the full voice pipeline: continuous STT, streaming TTS,
 * interruption handling, configurable conversation history, and the WebSocket
 * voice protocol. The transcriber session is per-call — created at start_call,
 * closed at end_call. The model handles turn detection.
 *
 * Event map and ownership:
 * - `#handleStartCall` and `#handleEndCall` own call lifecycle.
 * - `#handleInterrupt` and `#handleBargeIn` decide interruption policy.
 * - `#runPipeline` and `#streamResponse` own turn and response processing.
 * - `AudioConnectionManager` alone owns the active pipeline AbortController.
 *
 * Fork extensions are Flux eager/speculative turns, assistant-echo rejection,
 * call-start input suppression, server audio transports, and playback markers.
 * Rejected echo or short-fragment STT events must not replace the active
 * pipeline. Accepted barge-in emits `playback_interrupt`; carrier clearing
 * remains the audio transport adapter's responsibility.
 *
 * @experimental This API is not yet stable and may change.
 */

import type { Agent, Connection, WSMessage } from "agents";
import { SentenceChunker } from "./sentence-chunker";
import { logVoiceError, toVoiceError, voiceErrorMessage } from "./errors";
import {
  ServerDiagnostics,
  type DiagnosticData,
  type ModelDiagnosticTracker,
  type TurnDiagnostics
} from "./diagnostics";
import { countTranscriptWords, isEchoOf } from "./voice-interruption";
import {
  iterateTextEvents,
  type TextSource,
  type TextStreamEvent
} from "./text-stream";
import { VOICE_PROTOCOL_VERSION } from "./types";
import type {
  VoiceRole,
  VoiceAudioFormat,
  TTSProvider,
  StreamingTTSProvider,
  StreamingTextTTSProvider,
  Transcriber,
  TranscriberSession,
  VoiceServerAudioTransport,
  VoiceCallStartContext,
  VoicePlaybackMarkerMessage,
  VoiceCompletionOutcome,
  VoiceModelFinishReason,
  VoiceDiagnosticsOptions,
  VoiceTurnOutcome
} from "./types";
import {
  AudioConnectionManager,
  runBackground,
  sendVoiceJSON
} from "./audio-pipeline";

type ClientSpeechEnergy = {
  startRms: number | null;
  peakRms: number | null;
  threshold: number | null;
};
type ClientPlaybackMarkerState = {
  markers: Map<string, string>;
  acknowledgedMarkers: Set<string>;
  acknowledgedText: string[];
};
type TTSOutputEvent =
  | { type: "audio"; audio: ArrayBuffer }
  | {
      type: "playback_marker";
      playbackId: string;
      sequence: number;
      text: string;
    };

type PlaybackTextTransport = VoiceServerAudioTransport & {
  resetPlaybackText(connectionId: string): void;
  markPlaybackText(connectionId: string, text: string): void;
  getPlaybackText(connectionId: string): string;
};

function playbackTextTransport(
  transport: VoiceServerAudioTransport | undefined
): PlaybackTextTransport | null {
  if (
    typeof transport?.resetPlaybackText !== "function" ||
    typeof transport.markPlaybackText !== "function" ||
    typeof transport.getPlaybackText !== "function"
  ) {
    return null;
  }
  return transport as PlaybackTextTransport;
}

function playbackMarkerKey(playbackId: string, sequence: number): string {
  return `${playbackId}:${sequence}`;
}

function readClientRms(
  message: object,
  key: "rms" | "peak_rms" | "threshold"
): number | null {
  const value = (message as Record<string, unknown>)[key];
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
    ? value
    : null;
}

// Re-export SentenceChunker for direct use
export { SentenceChunker } from "./sentence-chunker";

// Re-export protocol version constant
export { VOICE_PROTOCOL_VERSION } from "./types";

export type {
  VoiceStatus,
  VoiceRole,
  VoiceAudioFormat,
  VoiceCallStartContext,
  VoicePlaybackMarkerMessage,
  VoicePlaybackMarkerAckMessage,
  VoiceAudioInput,
  VoiceTransport,
  VoiceServerAudioTransport,
  VoiceTransportCloseInfo,
  VoiceError,
  VoiceErrorCode,
  VoiceErrorStage,
  VoiceCompletionOutcome,
  VoiceCompletionOutcomeCode,
  VoiceModelFinishReason,
  VoiceDiagnosticsOptions,
  VoiceDiagnosticEvent,
  VoiceTurnMetrics,
  VoiceTurnOutcome,
  VoiceTurnSource,
  VoiceClientMessage,
  VoiceServerMessage,
  VoicePipelineMetrics,
  TranscriptMessage,
  TTSProvider,
  StreamingTTSProvider,
  StreamingTextTTSProvider,
  Transcriber,
  TranscriberSession,
  TranscriberSessionOptions
} from "./types";

// Re-export voice input mixin (STT-only, no TTS/LLM)
export { withVoiceInput, type VoiceInputOptions } from "./voice-input";

// Re-export text stream utility
export { iterateText, type TextSource } from "./text-stream";

// Re-export SFU utility functions
export {
  decodeVarint,
  encodeVarint,
  extractPayloadFromProtobuf,
  encodePayloadToProtobuf,
  downsample48kStereoTo16kMono,
  upsample16kMonoTo48kStereo,
  resampleMonoTo48kStereo,
  resample24kMonoTo48kStereo,
  sfuFetch,
  createSFUSession,
  addSFUTracks,
  updateSFUTracks,
  getSFUSession,
  renegotiateSFUSession,
  createSFUWebSocketAdapter,
  closeSFUWebSocketAdapter
} from "./sfu-utils";
export type { SFUConfig } from "./sfu-utils";

// Re-export Workers AI providers
export {
  WorkersAITTS,
  WorkersAIRealtimeTTS,
  WorkersAIGrokTTS,
  WorkersAIFluxSTT,
  WorkersAINova3STT
} from "./workers-ai-providers";
export type {
  WorkersAITTSOptions,
  WorkersAIRealtimeTTSOptions,
  WorkersAIGrokTTSOptions,
  WorkersAIFluxSTTOptions,
  WorkersAINova3STTOptions
} from "./workers-ai-providers";

// --- Public types ---

/** Context passed to the `onTurn()` hook. */
export interface VoiceTurnContext {
  connection: Connection;
  /** Completed conversation history before the current transcript. */
  messages: Array<{ role: VoiceRole; content: string }>;
  signal: AbortSignal;
}

/** Configuration options for the voice mixin. Passed to `withVoice()`. */
export interface VoiceAgentOptions {
  /** Max conversation history messages loaded for context. @default 20 */
  historyLimit?: number;
  /** Audio format used for binary audio payloads sent to the client. @default "mp3" */
  audioFormat?: VoiceAudioFormat;
  /**
   * Sample rate (Hz) of raw PCM audio payloads sent to the client.
   * Declared in the `audio_config` message so the client can play `pcm16`
   * at the provider's native rate (e.g. 24000 for Gemini TTS).
   * Encoded formats (mp3/wav/opus) carry their own rate and ignore this.
   * @default 16000
   */
  sampleRate?: number;
  /**
   * Persist conversation messages in Durable Object SQLite so they survive
   * eviction and restart. When false, messages exist only for the current
   * Durable Object instance. @default true
   */
  persistMessages?: boolean;
  /** Max conversation messages to retain. Oldest are pruned. @default 1000 */
  maxMessageCount?: number;
  /**
   * Drop transcriptions that closely match the previous assistant message.
   * This suppresses speakerphone echo after STT without disabling barge-in.
   * @default false
   */
  filterEchoedTranscripts?: boolean;
  /**
   * Accept inbound audio while `onCallStart()` runs. Disable when the hook
   * plays an opening greeting and the transport can loop that audio back into
   * STT. The opening hook is not interruptible while disabled. @default true
   */
  listenDuringCallStart?: boolean;
  /**
   * Minimum words the transcript must contain before a barge-in is allowed
   * to interrupt active playback. Suppresses single-word backchannels
   * ("yeah", "okay") and short echo fragments from cutting off the
   * assistant mid-sentence. Applies to `onSpeechStart` and a pending
   * `onSpeechUpdate` -- client-side `audio_level` interrupts carry no
   * transcript and are never gated by this option. `0` disables the gate.
   * @default 0
   */
  minInterruptWords?: number;
  /** Optional diagnostic output. Diagnostic event names and metadata are not stable API. */
  diagnostics?: VoiceDiagnosticsOptions;
}

interface SpeculativeTurn {
  provisionalTranscript: string;
  startedAt: number;
  outcome: Promise<boolean>;
  pipelineStarted: boolean;
  settle(confirmed: boolean): void;
}
interface ActiveAssistantText {
  signal: AbortSignal;
  text: string;
}
type SpeculativeCancelReason =
  | "turn_resumed"
  | "speech_start"
  | "interrupt"
  | "end_call"
  | "connection_closed"
  | "transcript_mismatch";
const DEFAULT_HISTORY_LIMIT = 20;

const DEFAULT_MAX_MESSAGE_COUNT = 1000;
const DEFAULT_SAMPLE_RATE = 16000;
const STREAMING_TTS_MAX_CHARS = 48;

class ModelStreamError extends Error {
  readonly streamError: Error;
  readonly partialOutput: boolean;

  constructor(streamError: Error, partialOutput: boolean) {
    super(streamError.message, { cause: streamError });
    this.name = "ModelStreamError";
    this.streamError = streamError;
    this.partialOutput = partialOutput;
  }
}

function completionOutcomeCode(
  finishReason: VoiceModelFinishReason | undefined,
  hasOutput: boolean
): VoiceCompletionOutcome["code"] | null {
  if (finishReason === "length") return "output_limit";
  if (finishReason === "content-filter") return "content_filtered";
  if (finishReason === "error") return "model_error";
  return hasOutput ? null : "no_output";
}

function stableTurnOutcome(
  finishReason: VoiceModelFinishReason | undefined,
  hasOutput: boolean
): VoiceTurnOutcome {
  return completionOutcomeCode(finishReason, hasOutput) ?? "completed";
}

function createCompletionOutcome(
  finishReason: VoiceModelFinishReason | undefined,
  partialOutput: boolean
): VoiceCompletionOutcome | null {
  const code = completionOutcomeCode(finishReason, partialOutput);
  return code === null
    ? null
    : {
        code,
        stage: "llm",
        ...(finishReason === undefined ? {} : { finishReason }),
        partialOutput
      };
}

// --- Mixin ---

// oxlint-disable-next-line @typescript-eslint/no-explicit-any -- mixin constructor constraint
type Constructor<T = object> = new (...args: any[]) => T;

type AgentLike = Constructor<Agent<Cloudflare.Env>>;

type ActiveTurnDiagnostics = {
  signal: AbortSignal;
  turn: TurnDiagnostics;
  model?: ModelDiagnosticTracker;
};

/** Public surface of the voice mixin, used as an explicit return type to satisfy TS6 declaration emit. */
export interface VoiceAgentMixinMembers {
  transcriber?: Transcriber;
  tts?: (TTSProvider & Partial<StreamingTTSProvider>) | undefined;
  createTranscriber(connection: Connection): Transcriber | null;
  createAudioTransport(
    connection: Connection
  ):
    | VoiceServerAudioTransport
    | null
    | Promise<VoiceServerAudioTransport | null>;
  receiveAudio(connectionId: string, audio: ArrayBuffer): void;
  getPlaybackText(connectionId: string): string | null;
  beforeCallStart(connection: Connection): boolean | Promise<boolean>;
  onCallStart(
    connection: Connection,
    context: VoiceCallStartContext
  ): void | Promise<void>;
  onCallEnd(connection: Connection): void | Promise<void>;
  onInterrupt(connection: Connection): void | Promise<void>;
  afterTranscribe(
    transcript: string,
    connection: Connection
  ): string | null | Promise<string | null>;
  beforeSynthesize(
    text: string,
    connection: Connection
  ): string | null | Promise<string | null>;
  afterSynthesize(
    audio: ArrayBuffer | null,
    text: string,
    connection: Connection
  ): ArrayBuffer | null | Promise<ArrayBuffer | null>;
  saveMessage(role: "user" | "assistant", text: string): void;
  getConversationHistory(
    limit?: number
  ): Array<{ role: VoiceRole; content: string }>;
  forceEndCall(connection: Connection): void;
  speak(connection: Connection, text: string): Promise<void>;
  speakAll(text: string): Promise<void>;
}

type VoiceAgentMixinReturn<TBase extends AgentLike> = TBase &
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- mixin constructor must accept any args
  (new (...args: any[]) => VoiceAgentMixinMembers);

/**
 * Voice pipeline mixin. Adds the full voice pipeline to an Agent class.
 *
 * Subclasses must set a `transcriber` property (or override `createTranscriber`)
 * and a `tts` provider property. The transcriber session is per-call — created
 * at start_call and closed at end_call. The model handles turn detection.
 *
 * @param Base - The Agent class to extend (e.g. `Agent`).
 * @param voiceOptions - Optional pipeline configuration.
 *
 * @example
 * ```typescript
 * import { Agent } from "agents";
 * import { withVoice, WorkersAIFluxSTT, WorkersAITTS } from "@cloudflare/voice";
 *
 * const VoiceAgent = withVoice(Agent);
 *
 * class MyAgent extends VoiceAgent<Env> {
 *   transcriber = new WorkersAIFluxSTT(this.env.AI);
 *   tts = new WorkersAITTS(this.env.AI);
 *
 *   async onTurn(transcript, context) {
 *     return "Hello! I heard you say: " + transcript;
 *   }
 * }
 * ```
 */
export function withVoice<TBase extends AgentLike>(
  Base: TBase,
  voiceOptions?: VoiceAgentOptions
): VoiceAgentMixinReturn<TBase> {
  const opts = voiceOptions ?? {};
  const diagnostics = new ServerDiagnostics(
    opts.diagnostics?.browserConsole === true
  );

  function opt<K extends keyof VoiceAgentOptions>(
    key: K,
    fallback: NonNullable<VoiceAgentOptions[K]>
  ): NonNullable<VoiceAgentOptions[K]> {
    return (opts[key] ?? fallback) as NonNullable<VoiceAgentOptions[K]>;
  }

  class VoiceAgentMixin extends Base {
    // --- Provider properties (set by subclass) ---

    /** Continuous transcriber provider. */
    transcriber?: Transcriber;
    /** Text-to-speech provider. Required. */
    tts?: TTSProvider & Partial<StreamingTTSProvider>;

    // Shared per-connection audio state manager
    #cm = new AudioConnectionManager("VoiceAgent");

    // keepAlive dispose functions per connection (prevents DO eviction during calls)
    #keepAliveDispose = new Map<string, () => void>();

    // Optional server audio transports keyed by their voice connection.
    #audioTransports = new Map<string, VoiceServerAudioTransport>();
    // Default history exists only for this Durable Object instance.
    #conversationHistory: Array<{ role: VoiceRole; content: string }> = [];
    // Speculative Flux responses wait for EndOfTurn before entering history.
    #speculativeTurns = new Map<string, SpeculativeTurn>();
    // Text currently being spoken, used to reject live speakerphone echo.
    #activeAssistantText = new Map<string, ActiveAssistantText>();
    // Connections whose opening hook should not feed inbound audio to STT.
    #callStartInputSuppressed = new Set<string>();
    // Client-captured microphone energy for the current STT turn.
    #clientSpeechEnergy = new Map<string, ClientSpeechEnergy>();
    // Connections waiting for transcript growth to meet minInterruptWords.
    #pendingBargeInConnections = new Set<string>();

    // Current async start_call identity per connection, used to ignore stale readiness.
    #startupTokens = new Map<string, symbol>();
    // Connections that explicitly opted into sentence playback markers.
    #playbackMarkerConnections = new Set<string>();
    // Carrier-acknowledged marker text for clients that support acknowledgements.
    #clientPlaybackMarkers = new Map<string, ClientPlaybackMarkerState>();
    // Persists after readiness so callbacks from replaced sessions cannot affect a newer call.
    #callTokens = new Map<string, symbol>();
    #turnSequence = 0;
    #inputTurns = new Map<string, TurnDiagnostics>();
    #activeTurnDiagnostics = new Map<string, ActiveTurnDiagnostics>();

    // Voice protocol message types handled internally
    static #VOICE_MESSAGES = new Set([
      "hello",
      "start_call",
      "end_call",
      "start_of_speech",
      "end_of_speech",
      "interrupt",
      "playback_marker_ack",
      "text_message"
    ]);

    // --- Agent lifecycle ---
    #schemaReady = false;

    #ensureMessageSchema() {
      if (this.#schemaReady) return;
      this.sql`
        CREATE TABLE IF NOT EXISTS cf_voice_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          role TEXT NOT NULL,
          text TEXT NOT NULL,
          timestamp INTEGER NOT NULL
        )
      `;
      this.#schemaReady = true;
    }

    // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- mixin constructor must accept any args
    constructor(...args: any[]) {
      super(...args);

      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- binding consumer methods
      const _onConnect = (this as any).onConnect?.bind(this);
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- binding consumer methods
      const _onClose = (this as any).onClose?.bind(this);
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- binding consumer methods
      const _onMessage = (this as any).onMessage?.bind(this);

      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- overwriting lifecycle
      (this as any).onConnect = (
        connection: Connection,
        ...rest: unknown[]
      ) => {
        this.#sendJSON(connection, {
          type: "welcome",
          protocol_version: VOICE_PROTOCOL_VERSION,
          ...(diagnostics.browserConsole
            ? { diagnostics: { browser_console: true as const } }
            : {})
        });
        this.#diagnose(connection, "connection.opened");
        this.#sendJSON(connection, { type: "status", status: "idle" });
        return _onConnect?.(connection, ...rest);
      };

      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- overwriting lifecycle
      (this as any).onClose = (connection: Connection, ...rest: unknown[]) => {
        this.#diagnose(connection, "connection.closed", {
          in_call: this.#cm.isInCall(connection.id)
        });
        this.#requestActiveTurnAbort(
          connection,
          "turn.abort_requested",
          "connection_closed"
        );
        this.#abortInputTurn(connection, "connection_closed");
        this.#activeTurnDiagnostics.delete(connection.id);
        this.#startupTokens.delete(connection.id);
        this.#activeAssistantText.delete(connection.id);
        this.#callStartInputSuppressed.delete(connection.id);
        this.#playbackMarkerConnections.delete(connection.id);
        this.#clientPlaybackMarkers.delete(connection.id);
        this.#clientSpeechEnergy.delete(connection.id);
        this.#pendingBargeInConnections.delete(connection.id);
        this.#callTokens.delete(connection.id);
        this.#releaseKeepAlive(connection.id);
        this.#cm.cleanup(connection.id);
        const transport = this.#audioTransports.get(connection.id);
        if (transport) {
          this.#audioTransports.delete(connection.id);
          if (transport.suspend) {
            transport.suspend(connection.id);
          } else {
            runBackground("audio_transport_stop", () =>
              transport.stop(connection.id)
            );
          }
        }
        this.#cancelSpeculativeTurn(connection.id, "connection_closed");
        return _onClose?.(connection, ...rest);
      };

      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- overwriting lifecycle
      (this as any).onMessage = (
        connection: Connection,
        message: WSMessage
      ) => {
        if (message instanceof ArrayBuffer) {
          this.receiveAudio(connection.id, message);
          return;
        }

        if (typeof message !== "string") {
          return _onMessage?.(connection, message);
        }

        let parsed: object;
        let messageType: string;
        try {
          const value: unknown = JSON.parse(message);
          if (
            !value ||
            typeof value !== "object" ||
            !("type" in value) ||
            typeof value.type !== "string"
          ) {
            return _onMessage?.(connection, message);
          }
          parsed = value;
          messageType = value.type;
        } catch {
          return _onMessage?.(connection, message);
        }

        if (VoiceAgentMixin.#VOICE_MESSAGES.has(messageType)) {
          switch (messageType) {
            case "hello":
              break;
            case "start_call": {
              const playbackMarkers =
                "playback_markers" in parsed &&
                parsed.playback_markers === true;
              if (playbackMarkers) {
                this.#playbackMarkerConnections.add(connection.id);
              } else {
                this.#playbackMarkerConnections.delete(connection.id);
              }
              if (
                playbackMarkers &&
                "playback_marker_acks" in parsed &&
                parsed.playback_marker_acks === true
              ) {
                this.#clientPlaybackMarkers.set(connection.id, {
                  markers: new Map(),
                  acknowledgedMarkers: new Set(),
                  acknowledgedText: []
                });
              } else {
                this.#clientPlaybackMarkers.delete(connection.id);
              }
              const preferredFormat =
                "preferred_format" in parsed &&
                typeof parsed.preferred_format === "string"
                  ? parsed.preferred_format
                  : undefined;
              const resumed = "resumed" in parsed && parsed.resumed === true;
              runBackground("start_call", () =>
                this.#handleStartCall(connection, preferredFormat, resumed)
              );
              break;
            }
            case "end_call":
              this.#playbackMarkerConnections.delete(connection.id);
              this.#clientPlaybackMarkers.delete(connection.id);
              runBackground("end_call", () => this.#handleEndCall(connection));
              break;
            case "start_of_speech":
              this.#clientSpeechEnergy.set(connection.id, {
                startRms: readClientRms(parsed, "rms"),
                peakRms: null,
                threshold: readClientRms(parsed, "threshold")
              });
              break;
            case "end_of_speech": {
              const energy = this.#clientSpeechEnergy.get(connection.id);
              this.#clientSpeechEnergy.set(connection.id, {
                startRms: energy?.startRms ?? null,
                peakRms: readClientRms(parsed, "peak_rms"),
                threshold:
                  readClientRms(parsed, "threshold") ??
                  energy?.threshold ??
                  null
              });
              break;
            }
            case "interrupt": {
              const source =
                "source" in parsed && parsed.source === "audio_level"
                  ? "client_audio_level"
                  : "client_interrupt";
              runBackground("interrupt", () =>
                this.#handleInterrupt(connection, source)
              );
              break;
            }
            case "playback_marker_ack": {
              const state = this.#clientPlaybackMarkers.get(connection.id);
              const playbackId =
                "playbackId" in parsed ? parsed.playbackId : undefined;
              const sequence =
                "sequence" in parsed ? parsed.sequence : undefined;
              if (
                !state ||
                typeof playbackId !== "string" ||
                playbackId.length === 0 ||
                !Number.isInteger(sequence) ||
                typeof sequence !== "number" ||
                sequence <= 0
              ) {
                break;
              }
              const key = playbackMarkerKey(playbackId, sequence);
              const text = state.markers.get(key);
              if (text === undefined || state.acknowledgedMarkers.has(key)) {
                break;
              }
              state.acknowledgedMarkers.add(key);
              state.acknowledgedText.push(text);
              break;
            }
            case "text_message": {
              const text = "text" in parsed ? parsed.text : undefined;
              if (typeof text === "string") {
                runBackground("text_message", () =>
                  this.#handleTextMessage(connection, text)
                );
              }
              break;
            }
          }
          return;
        }

        return _onMessage?.(connection, message);
      };
    }

    // --- User-overridable hooks ---

    onTurn(
      _transcript: string,
      _context: VoiceTurnContext
    ): Promise<TextSource> {
      throw new Error(
        "VoiceAgent subclass must implement onTurn(). Return a string, AI SDK stream, AsyncIterable<string>, or ReadableStream."
      );
    }

    /**
     * Override to create a transcriber dynamically per connection.
     * Useful for runtime model switching (e.g. Flux vs Nova 3 dropdown).
     * Return null to fall back to the `transcriber` property.
     */
    createTranscriber(_connection: Connection): Transcriber | null {
      return null;
    }

    createAudioTransport(
      _connection: Connection
    ):
      | VoiceServerAudioTransport
      | null
      | Promise<VoiceServerAudioTransport | null> {
      return null;
    }

    receiveAudio(connectionId: string, audio: ArrayBuffer): void {
      if (this.#callStartInputSuppressed.has(connectionId)) return;
      this.#cm.bufferAudio(connectionId, audio);
    }
    getPlaybackText(connectionId: string): string | null {
      const transport = playbackTextTransport(
        this.#audioTransports.get(connectionId)
      );
      if (transport) return transport.getPlaybackText(connectionId);
      return (
        this.#clientPlaybackMarkers
          .get(connectionId)
          ?.acknowledgedText.join(" ") ?? null
      );
    }
    #hasPendingPlayback(connectionId: string): boolean {
      const state = this.#clientPlaybackMarkers.get(connectionId);
      if (!state) return false;
      for (const key of state.markers.keys()) {
        if (!state.acknowledgedMarkers.has(key)) return true;
      }
      return false;
    }

    #hasInterruptibleOutput(connectionId: string): boolean {
      return (
        this.#cm.hasActivePipeline(connectionId) ||
        this.#hasPendingPlayback(connectionId)
      );
    }

    #clearClientPlaybackMarkers(connectionId: string): void {
      const state = this.#clientPlaybackMarkers.get(connectionId);
      state?.markers.clear();
      state?.acknowledgedMarkers.clear();
    }

    beforeCallStart(_connection: Connection): boolean | Promise<boolean> {
      return true;
    }

    onCallStart(
      _connection: Connection,
      _context: VoiceCallStartContext
    ): void | Promise<void> {}
    onCallEnd(_connection: Connection): void | Promise<void> {}
    onInterrupt(_connection: Connection): void | Promise<void> {}

    afterTranscribe(
      transcript: string,
      connection: Connection
    ): string | null | Promise<string | null> {
      return opt("filterEchoedTranscripts", false) &&
        this.#isEchoTranscript(connection.id, transcript)
        ? null
        : transcript;
    }

    #isEchoTranscript(connectionId: string, transcript: string): boolean {
      const active = this.#activeAssistantText.get(connectionId);
      if (active && isEchoOf(transcript, active.text)) return true;
      const history = this.getConversationHistory();
      for (let i = history.length - 1; i >= 0; i--) {
        if (history[i].role === "assistant") {
          return isEchoOf(transcript, history[i].content);
        }
      }
      return false;
    }

    beforeSynthesize(
      text: string,
      _connection: Connection
    ): string | null | Promise<string | null> {
      return text;
    }

    afterSynthesize(
      audio: ArrayBuffer | null,
      _text: string,
      _connection: Connection
    ): ArrayBuffer | null | Promise<ArrayBuffer | null> {
      return audio;
    }

    // --- Conversation history ---

    saveMessage(role: "user" | "assistant", text: string) {
      const maxMessages = opt("maxMessageCount", DEFAULT_MAX_MESSAGE_COUNT);

      if (!opt("persistMessages", true)) {
        this.#conversationHistory.push({ role, content: text });
        const excess = this.#conversationHistory.length - maxMessages;
        if (excess > 0) this.#conversationHistory.splice(0, excess);
        return;
      }

      this.#ensureMessageSchema();
      this.sql`
        INSERT INTO cf_voice_messages (role, text, timestamp)
        VALUES (${role}, ${text}, ${Date.now()})
      `;
      this.sql`
        DELETE FROM cf_voice_messages
        WHERE id NOT IN (
          SELECT id FROM cf_voice_messages
          ORDER BY id DESC LIMIT ${maxMessages}
        )
      `;
    }

    getConversationHistory(
      limit?: number
    ): Array<{ role: VoiceRole; content: string }> {
      const historyLimit = limit ?? opt("historyLimit", DEFAULT_HISTORY_LIMIT);
      if (historyLimit <= 0) return [];

      if (!opt("persistMessages", true)) {
        return this.#conversationHistory
          .slice(-historyLimit)
          .map((message) => ({ ...message }));
      }

      this.#ensureMessageSchema();
      const rows = this.sql<{ role: VoiceRole; text: string }>`
        SELECT role, text FROM cf_voice_messages
        ORDER BY id DESC LIMIT ${historyLimit}
      `;
      return rows.reverse().map((row) => ({
        role: row.role,
        content: row.text
      }));
    }

    // --- Audio transport helpers ---

    async #sendAudio(
      connection: Connection,
      audio: ArrayBuffer
    ): Promise<void> {
      const transport = this.#audioTransports.get(connection.id);
      if (transport) {
        await transport.send(connection.id, audio);
      } else {
        connection.send(audio);
      }
    }
    async #flushAudio(connection: Connection): Promise<void> {
      await this.#audioTransports.get(connection.id)?.flush(connection.id);
    }

    async #stopAudioTransport(connectionId: string): Promise<void> {
      const transport = this.#audioTransports.get(connectionId);
      if (!transport) return;
      this.#audioTransports.delete(connectionId);
      await transport.stop(connectionId);
    }

    // --- Speculative-turn bookkeeping ---

    #cancelSpeculativeTurn(
      connectionId: string,
      _reason: SpeculativeCancelReason
    ): SpeculativeTurn | null {
      const turn = this.#speculativeTurns.get(connectionId);
      if (!turn) return null;
      this.#speculativeTurns.delete(connectionId);
      turn.settle(false);
      return turn;
    }

    #startSpeculativeTurn(
      connection: Connection,
      transcript: string,
      diagnosticTurn: TurnDiagnostics
    ): void {
      if (this.#speculativeTurns.has(connection.id)) return;
      let settle: (confirmed: boolean) => void = () => {};
      const outcome = new Promise<boolean>((resolve) => {
        settle = resolve;
      });
      const speculative: SpeculativeTurn = {
        provisionalTranscript: transcript.trim(),
        startedAt: Date.now(),
        outcome,
        settle,
        pipelineStarted: false
      };
      this.#speculativeTurns.set(connection.id, speculative);
      void this.#runPipeline(
        connection,
        transcript,
        diagnosticTurn,
        speculative
      );
    }

    // --- Public call controls ---

    forceEndCall(connection: Connection): void {
      if (!this.#cm.isInCall(connection.id)) return;
      runBackground("force_end_call", () => this.#handleEndCall(connection));
    }

    async speak(connection: Connection, text: string): Promise<void> {
      const signal = this.#cm.createPipelineAbort(connection.id);
      try {
        this.#sendJSON(connection, {
          type: "transcript_start",
          role: "assistant"
        });
        this.#sendJSON(connection, { type: "transcript_end", text });

        await this.#speakText(connection, text, signal);
        if (!signal.aborted) {
          this.#cm.updateAgentContext(connection.id, text);
          this.saveMessage("assistant", text);
          this.#sendJSON(connection, { type: "status", status: "listening" });
        }
      } finally {
        this.#cm.clearPipelineAbort(connection.id, signal);
      }
    }

    async speakAll(text: string): Promise<void> {
      this.saveMessage("assistant", text);

      const connections = [...this.getConnections()];
      if (connections.length === 0) return;

      for (const connection of connections) {
        const signal = this.#cm.createPipelineAbort(connection.id);
        try {
          this.#sendJSON(connection, {
            type: "transcript_start",
            role: "assistant"
          });
          this.#sendJSON(connection, { type: "transcript_end", text });

          await this.#speakText(connection, text, signal);

          if (!signal.aborted) {
            this.#cm.updateAgentContext(connection.id, text);
            this.#sendJSON(connection, {
              type: "status",
              status: "listening"
            });
          }
        } finally {
          this.#cm.clearPipelineAbort(connection.id, signal);
        }
      }
    }

    // --- Synthesis helpers ---

    #requireTTS(): TTSProvider & Partial<StreamingTTSProvider> {
      if (!this.tts) {
        throw new Error(
          "No TTS provider configured. Set 'tts' on your VoiceAgent subclass."
        );
      }
      return this.tts;
    }

    async #synthesizeWithHooks(
      text: string,
      connection: Connection,
      signal?: AbortSignal,
      turn?: TurnDiagnostics
    ): Promise<ArrayBuffer | null> {
      const sentence = turn?.beginTtsSentence();
      let sentenceOutcome: "completed" | "skipped" | "failed" = "completed";
      try {
        let textToSpeak: string | null;
        try {
          textToSpeak = await this.beforeSynthesize(text, connection);
        } catch (error) {
          const voiceError = toVoiceError(error, "TTS preparation failed");
          this.#emitTurnDiagnostic(connection, turn, "tts.failed", {
            stage: "before_synthesize",
            error: voiceError
          });
          throw voiceError;
        }

        if (!textToSpeak) {
          sentenceOutcome = "skipped";
          this.#emitTurnDiagnostic(connection, turn, "tts.skipped", {
            reason: "before_synthesize"
          });
          return null;
        }

        let tts: TTSProvider & Partial<StreamingTTSProvider>;
        try {
          tts = this.#requireTTS();
        } catch (error) {
          const voiceError = toVoiceError(error, "TTS is not configured");
          this.#emitTurnDiagnostic(connection, turn, "tts.failed", {
            stage: "configuration",
            error: voiceError
          });
          throw voiceError;
        }

        const startedAt = Date.now();
        this.#emitTurnDiagnostic(connection, turn, "tts.started", {
          characters: textToSpeak.length
        });
        sentence?.providerStarted();
        try {
          const rawAudio = await tts.synthesize(textToSpeak, signal);
          const audio = await this.afterSynthesize(
            rawAudio,
            textToSpeak,
            connection
          );
          this.#emitTurnDiagnostic(connection, turn, "tts.completed", {
            duration_ms: Date.now() - startedAt,
            outcome: audio ? "audio" : "no_audio",
            bytes: audio?.byteLength ?? 0
          });
          return audio;
        } catch (error) {
          const voiceError = toVoiceError(error, "TTS failed");
          this.#emitTurnDiagnostic(connection, turn, "tts.failed", {
            duration_ms: Date.now() - startedAt,
            error: voiceError
          });
          throw voiceError;
        }
      } catch (error) {
        sentenceOutcome = "failed";
        throw error;
      } finally {
        sentence?.settle(sentenceOutcome);
      }
    }

    async #speakText(
      connection: Connection,
      text: string,
      signal: AbortSignal
    ): Promise<void> {
      const tts = this.#requireTTS();
      if (typeof tts.synthesizeStream === "function") {
        const startedAt = Date.now();
        const textToSpeak = await this.beforeSynthesize(text, connection);
        if (!textToSpeak || signal.aborted) {
          this.#diagnose(connection, "tts.skipped", {
            reason: "before_synthesize"
          });
          return;
        }

        let totalBytes = 0;
        this.#diagnose(connection, "tts.started", {
          mode: "streaming",
          characters: textToSpeak.length
        });
        try {
          for await (const chunk of tts.synthesizeStream(textToSpeak, signal)) {
            if (signal.aborted) return;
            const processed = await this.afterSynthesize(
              chunk,
              textToSpeak,
              connection
            );
            if (!processed) continue;
            if (totalBytes === 0) {
              this.#sendJSON(connection, {
                type: "status",
                status: "speaking"
              });
              this.#diagnose(connection, "audio.first_sent", {
                bytes: processed.byteLength
              });
            }
            totalBytes += processed.byteLength;
            await this.#sendAudio(connection, processed);
          }
          if (!signal.aborted) await this.#flushAudio(connection);
          this.#diagnose(connection, "tts.completed", {
            duration_ms: Date.now() - startedAt,
            outcome: totalBytes > 0 ? "audio" : "no_audio",
            bytes: totalBytes
          });
          if (totalBytes > 0) {
            this.#diagnose(connection, "audio.completed", {
              bytes: totalBytes
            });
          }
        } catch (error) {
          const voiceError = toVoiceError(error, "TTS failed");
          this.#diagnose(connection, "tts.failed", {
            duration_ms: Date.now() - startedAt,
            error: voiceError
          });
          throw voiceError;
        }
        return;
      }

      const audio = await this.#synthesizeWithHooks(text, connection, signal);
      if (audio && !signal.aborted) {
        this.#sendJSON(connection, { type: "status", status: "speaking" });
        this.#diagnose(connection, "audio.first_sent", {
          bytes: audio.byteLength
        });
        await this.#sendAudio(connection, audio);
        this.#diagnose(connection, "audio.completed", {
          bytes: audio.byteLength
        });
      }
      if (!signal.aborted) await this.#flushAudio(connection);
    }

    // --- Call lifecycle ---

    async #handleStartCall(
      connection: Connection,
      _preferredFormat?: string,
      resumed = false
    ) {
      if (this.#cm.isInCall(connection.id)) {
        this.#diagnose(connection, "call.start_ignored", {
          reason: "already_active"
        });
        return;
      }
      this.#clientSpeechEnergy.delete(connection.id);

      this.#diagnose(connection, "call.starting");
      this.#abortInputTurn(connection, "call_restarted");
      const startupToken = Symbol(connection.id);
      this.#startupTokens.set(connection.id, startupToken);
      this.#callTokens.set(connection.id, startupToken);

      // Mark as in-call before any await to prevent duplicate start_call
      // from leaking keepAlive refs during the beforeCallStart window.
      this.#cm.initConnection(connection.id);

      let provider: Transcriber | undefined;

      try {
        const allowed = await this.beforeCallStart(connection);
        if (!this.#isCurrentStartup(connection.id, startupToken)) return;
        if (!allowed) {
          await this.#handleStartupFailure(
            connection,
            startupToken,
            undefined,
            "Voice call was rejected",
            null
          );
          return;
        }

        const dispose = await this.keepAlive();
        if (!this.#isCurrentStartup(connection.id, startupToken)) {
          dispose();
          return;
        }
        this.#keepAliveDispose.set(connection.id, dispose);

        const configuredFormat =
          opts.audioFormat ?? this.tts?.audioFormat ?? "mp3";
        const configuredSampleRate =
          opts.sampleRate ?? this.tts?.sampleRate ?? DEFAULT_SAMPLE_RATE;
        this.#sendJSON(connection, {
          type: "audio_config",
          format: configuredFormat,
          sampleRate: configuredSampleRate
        });

        const transport = await this.createAudioTransport(connection);
        if (transport) {
          this.#audioTransports.set(connection.id, transport);
          const onAudio = (audio: ArrayBuffer) =>
            this.receiveAudio(connection.id, audio);
          if (resumed === true && transport.resume) {
            await transport.resume(connection.id, onAudio);
          } else {
            await transport.start(connection.id, onAudio);
          }
          if (!this.#isCurrentStartup(connection.id, startupToken)) return;
        }
        if (!this.#isCurrentStartup(connection.id, startupToken)) return;
        provider = this.createTranscriber(connection) ?? this.transcriber;
        if (!provider) {
          const message =
            "No transcriber configured. Set 'transcriber' on your VoiceAgent subclass or override createTranscriber().";
          logVoiceError({
            component: "VoiceAgent",
            stage: "configuration",
            message,
            connectionId: connection.id,
            error: new Error(message)
          });
          await this.#handleStartupFailure(
            connection,
            startupToken,
            undefined,
            message,
            null
          );
          return;
        }
      } catch (error) {
        await this.#handleStartupFailure(
          connection,
          startupToken,
          toVoiceError(error, "Voice call failed to start"),
          "Voice call failed to start"
        );
        return;
      }

      if (!provider) return;

      let session: TranscriberSession;
      try {
        this.#diagnose(connection, "stt.starting");
        session = this.#cm.startTranscriberSession(connection.id, provider, {
          onInterim: (text: string) => {
            if (this.#callTokens.get(connection.id) !== startupToken) return;
            const turn = this.#getOrCreateInputTurn(connection);
            turn.firstInterim(text.length);
            this.#sendJSON(connection, {
              type: "transcript_interim",
              text
            });
          },
          onSpeechStart: (transcript?: string) => {
            if (this.#callTokens.get(connection.id) !== startupToken) return;
            const turn = this.#replaceInputTurn(connection);
            turn.speechStarted();
            const echoed =
              opt("filterEchoedTranscripts", false) &&
              Boolean(
                transcript && this.#isEchoTranscript(connection.id, transcript)
              );
            const energy = this.#clientSpeechEnergy.get(connection.id);
            console.log("[VoiceTrace]", {
              event: "stt_speech_start",
              connectionId: connection.id,
              transcript: transcript ?? null,
              echoed,
              clientStartRms: energy?.startRms ?? null,
              clientThreshold: energy?.threshold ?? null
            });
            if (echoed) return;
            this.#handleBargeIn(connection, "onSpeechStart", transcript);
          },
          onSpeechUpdate: (transcript: string) => {
            if (this.#callTokens.get(connection.id) !== startupToken) return;
            if (!this.#pendingBargeInConnections.has(connection.id)) return;
            const echoed =
              opt("filterEchoedTranscripts", false) &&
              this.#isEchoTranscript(connection.id, transcript);
            if (
              echoed ||
              countTranscriptWords(transcript) < opt("minInterruptWords", 0)
            ) {
              return;
            }
            this.#handleBargeIn(connection, "onSpeechUpdate", transcript);
          },
          onEagerUtterance: (transcript: string) => {
            if (this.#callTokens.get(connection.id) !== startupToken) return;
            const echoed =
              opt("filterEchoedTranscripts", false) &&
              this.#isEchoTranscript(connection.id, transcript);
            const energy = this.#clientSpeechEnergy.get(connection.id);
            console.log("[VoiceTrace]", {
              event: "stt_eager_utterance",
              connectionId: connection.id,
              transcript,
              echoed,
              clientStartRms: energy?.startRms ?? null,
              clientThreshold: energy?.threshold ?? null
            });
            if (echoed) return;
            if (
              this.#pendingBargeInConnections.has(connection.id) &&
              this.#hasInterruptibleOutput(connection.id)
            ) {
              return;
            }
            const turn = this.#takeInputTurn(connection);
            turn.finalInput(transcript.length);
            this.#startSpeculativeTurn(connection, transcript, turn);
          },
          onTurnResumed: () => {
            if (this.#callTokens.get(connection.id) !== startupToken) return;
            const speculative = this.#cancelSpeculativeTurn(
              connection.id,
              "turn_resumed"
            );
            if (speculative) {
              this.#requestActiveTurnAbort(
                connection,
                "turn.abort_requested",
                "turn_resumed"
              );
              this.#cm.abortPipeline(connection.id);
            }
          },
          onUtterance: (transcript: string) => {
            if (this.#callTokens.get(connection.id) !== startupToken) return;
            const energy = this.#clientSpeechEnergy.get(connection.id);
            console.log("[VoiceTrace]", {
              event: "stt_utterance",
              connectionId: connection.id,
              text: transcript,
              clientStartRms: energy?.startRms ?? null,
              clientPeakRms: energy?.peakRms ?? null,
              clientThreshold: energy?.threshold ?? null
            });
            this.#clientSpeechEnergy.delete(connection.id);
            const speculative = this.#speculativeTurns.get(connection.id);
            const turn = speculative
              ? undefined
              : this.#takeInputTurn(connection);
            turn?.finalInput(transcript.length);
            this.#sendJSON(connection, {
              type: "transcript_interim",
              text: ""
            });
            const pendingBargeIn = this.#pendingBargeInConnections.delete(
              connection.id
            );
            if (pendingBargeIn && this.#hasInterruptibleOutput(connection.id)) {
              turn?.finish("skipped");
              return;
            }
            if (
              turn &&
              opt("filterEchoedTranscripts", false) &&
              this.#isEchoTranscript(connection.id, transcript)
            ) {
              turn.recordAfterTranscribe(0, "skipped", 0);
              turn.finish("skipped");
              return;
            }
            if (speculative) {
              this.#speculativeTurns.delete(connection.id);
              speculative.settle(true);
              return;
            }
            if (turn) this.#runPipeline(connection, transcript, turn);
          },
          onFatalError: (error: Error) => {
            if (this.#callTokens.get(connection.id) !== startupToken) return;
            runBackground("transcriber_fatal", () =>
              this.#handleTranscriberFatal(connection, startupToken, error)
            );
          }
        });

        await session.waitUntilReady?.();
      } catch (error) {
        await this.#handleTranscriberStartupFailure(
          connection,
          startupToken,
          toVoiceError(error, "Speech recognition failed to start")
        );
        return;
      }

      if (!this.#isCurrentStartup(connection.id, startupToken)) return;
      this.#startupTokens.delete(connection.id);

      this.#diagnose(connection, "stt.ready");
      this.#sendJSON(connection, { type: "status", status: "listening" });
      this.#diagnose(connection, "call.ready");
      if (!opt("listenDuringCallStart", true)) {
        this.#callStartInputSuppressed.add(connection.id);
      }
      try {
        await this.onCallStart(connection, { resumed });
      } finally {
        this.#callStartInputSuppressed.delete(connection.id);
      }
    }

    #isCurrentStartup(connectionId: string, startupToken: symbol): boolean {
      return (
        this.#startupTokens.get(connectionId) === startupToken &&
        this.#cm.isInCall(connectionId)
      );
    }

    async #handleTranscriberStartupFailure(
      connection: Connection,
      startupToken: symbol,
      error: Error
    ): Promise<void> {
      await this.#handleStartupFailure(
        connection,
        startupToken,
        error,
        "Speech recognition failed to start",
        "transcriber_startup",
        {
          code: "stt_startup_failed",
          stage: "stt",
          retryable: false
        }
      );
    }

    async #handleStartupFailure(
      connection: Connection,
      startupToken: symbol,
      error: Error | undefined,
      clientMessage: string,
      logStage: string | null = "call_startup",
      structuredError?: {
        code: "stt_startup_failed";
        stage: "stt";
        retryable: false;
      }
    ): Promise<void> {
      if (!this.#isCurrentStartup(connection.id, startupToken)) return;

      // The client starts local audio optimistically on start_call. Every
      // terminal startup path must send error + idle so it tears that down.
      if (logStage && error !== undefined) {
        logVoiceError({
          component: "VoiceAgent",
          stage: logStage,
          message: clientMessage,
          connectionId: connection.id,
          error
        });
      }
      this.#startupTokens.delete(connection.id);
      if (this.#callTokens.get(connection.id) === startupToken) {
        this.#callTokens.delete(connection.id);
      }
      this.#diagnose(connection, "call.start_failed", {
        stage: logStage ?? "authorization",
        retryable: structuredError?.retryable ?? false,
        ...(error === undefined ? {} : { error })
      });
      this.#sendJSON(connection, {
        type: "error",
        message: clientMessage,
        ...structuredError
      });
      try {
        await this.#stopAudioTransport(connection.id);
      } finally {
        this.#cm.cleanup(connection.id);
        this.#releaseKeepAlive(connection.id);
        this.#diagnose(connection, "cleanup.completed");
        this.#diagnose(connection, "call.ended", {
          reason: "startup_failed"
        });
        this.#sendJSON(connection, { type: "status", status: "idle" });
        await this.onCallEnd(connection);
      }
    }

    async #handleTranscriberFatal(
      connection: Connection,
      callToken: symbol,
      error: Error
    ): Promise<void> {
      if (
        this.#callTokens.get(connection.id) !== callToken ||
        !this.#cm.isInCall(connection.id)
      ) {
        return;
      }

      const isStarting = this.#startupTokens.get(connection.id) === callToken;
      const message = isStarting
        ? "Speech recognition failed to start"
        : "Speech recognition connection was lost";
      logVoiceError({
        component: "VoiceAgent",
        stage: isStarting ? "transcriber_startup" : "transcriber_runtime",
        message,
        connectionId: connection.id,
        error
      });
      this.#startupTokens.delete(connection.id);
      this.#callTokens.delete(connection.id);
      this.#abortInputTurn(connection, "stt_fatal");
      this.#diagnose(connection, "stt.fatal", {
        stage: isStarting ? "startup" : "runtime",
        retryable: !isStarting,
        error
      });
      this.#sendJSON(connection, {
        type: "error",
        message,
        code: isStarting ? "stt_startup_failed" : "stt_connection_lost",
        stage: "stt",
        retryable: !isStarting
      });
      try {
        await this.#stopAudioTransport(connection.id);
      } finally {
        this.#cm.cleanup(connection.id);
        this.#releaseKeepAlive(connection.id);
        this.#diagnose(connection, "cleanup.completed");
        this.#diagnose(connection, "call.ended", { reason: "stt_fatal" });
        this.#sendJSON(connection, { type: "status", status: "idle" });
        await this.onCallEnd(connection);
      }
    }

    #releaseKeepAlive(connectionId: string) {
      const dispose = this.#keepAliveDispose.get(connectionId);
      if (dispose) {
        dispose();
        this.#keepAliveDispose.delete(connectionId);
      }
    }
    async #handleEndCall(connection: Connection): Promise<void> {
      this.#diagnose(connection, "call.ended", { reason: "requested" });
      this.#requestActiveTurnAbort(
        connection,
        "turn.abort_requested",
        "call_ended"
      );
      this.#startupTokens.delete(connection.id);
      this.#callTokens.delete(connection.id);
      this.#abortInputTurn(connection, "call_ended");
      this.#clientSpeechEnergy.delete(connection.id);
      this.#pendingBargeInConnections.delete(connection.id);
      this.#cancelSpeculativeTurn(connection.id, "end_call");
      this.#cm.cleanup(connection.id);
      try {
        await this.#stopAudioTransport(connection.id);
      } finally {
        this.#releaseKeepAlive(connection.id);
        this.#diagnose(connection, "cleanup.completed");
        this.#sendJSON(connection, { type: "status", status: "idle" });
        await this.onCallEnd(connection);
      }
    }

    // --- Interruption policy ---

    async #handleInterrupt(
      connection: Connection,
      trigger: string
    ): Promise<void> {
      const activePipeline = this.#cm.hasActivePipeline(connection.id);
      const pendingPlayback = this.#hasPendingPlayback(connection.id);
      console.log("[VoiceTrace]", {
        event: "interrupt_trigger",
        connectionId: connection.id,
        trigger,
        transcript: null,
        activePipeline,
        pendingPlayback,
        action: "interrupt"
      });
      this.#abortInputTurn(connection, "client_interrupt");
      this.#requestActiveTurnAbort(
        connection,
        "turn.interrupt_requested",
        "client_interrupt"
      );
      this.#clearClientPlaybackMarkers(connection.id);
      this.#pendingBargeInConnections.delete(connection.id);
      this.#cm.abortPipeline(connection.id);
      this.#cancelSpeculativeTurn(connection.id, "interrupt");
      this.#cm.clearAudioBuffer(connection.id);
      this.#sendJSON(connection, { type: "status", status: "listening" });
      try {
        await this.#audioTransports
          .get(connection.id)
          ?.interrupt(connection.id);
      } finally {
        await this.onInterrupt(connection);
      }
    }

    #handleBargeIn(
      connection: Connection,
      trigger: "onSpeechStart" | "onSpeechUpdate",
      transcript?: string
    ): void {
      const activePipeline = this.#cm.hasActivePipeline(connection.id);
      const pendingPlayback = this.#hasPendingPlayback(connection.id);
      if (!this.#hasInterruptibleOutput(connection.id)) {
        console.log("[VoiceTrace]", {
          event: "interrupt_trigger",
          connectionId: connection.id,
          trigger,
          transcript: transcript ?? null,
          activePipeline,
          pendingPlayback,
          action: "no_interruptible_output"
        });
        return;
      }

      const minWords = opt("minInterruptWords", 0);
      if (minWords > 0 && countTranscriptWords(transcript) < minWords) {
        this.#pendingBargeInConnections.add(connection.id);
        console.log("[VoiceTrace]", {
          event: "interrupt_trigger",
          connectionId: connection.id,
          trigger,
          transcript: transcript ?? null,
          activePipeline,
          pendingPlayback,
          action: "below_min_words"
        });
        return;
      }

      this.#pendingBargeInConnections.delete(connection.id);
      this.#cancelSpeculativeTurn(connection.id, "speech_start");
      this.#clearClientPlaybackMarkers(connection.id);
      this.#requestActiveTurnAbort(
        connection,
        "turn.abort_requested",
        "barge_in"
      );
      this.#cm.abortPipeline(connection.id);
      console.log("[VoiceTrace]", {
        event: "interrupt_trigger",
        connectionId: connection.id,
        trigger,
        transcript: transcript ?? null,
        activePipeline,
        pendingPlayback,
        action: "interrupt"
      });
      this.#sendJSON(connection, { type: "playback_interrupt" });
      this.#sendJSON(connection, { type: "status", status: "listening" });
      runBackground("barge_in", async () => {
        try {
          await this.#audioTransports
            .get(connection.id)
            ?.interrupt(connection.id);
        } finally {
          await this.onInterrupt(connection);
        }
      });
    }

    #createTurn(
      connection: Connection,
      source: "speech" | "text"
    ): TurnDiagnostics {
      const turn = diagnostics.turn(
        connection,
        `turn_${(++this.#turnSequence).toString(36)}`,
        source
      );
      if (source === "text") turn.markTextInput();
      turn.emit("turn.started", { source });
      return turn;
    }

    #replaceInputTurn(connection: Connection): TurnDiagnostics {
      this.#abortInputTurn(connection, "replaced");
      const turn = this.#createTurn(connection, "speech");
      this.#inputTurns.set(connection.id, turn);
      return turn;
    }

    #getOrCreateInputTurn(connection: Connection): TurnDiagnostics {
      const current = this.#inputTurns.get(connection.id);
      if (current) return current;
      const turn = this.#createTurn(connection, "speech");
      this.#inputTurns.set(connection.id, turn);
      return turn;
    }

    #takeInputTurn(connection: Connection): TurnDiagnostics {
      const turn = this.#getOrCreateInputTurn(connection);
      this.#inputTurns.delete(connection.id);
      return turn;
    }

    #abortInputTurn(connection: Connection, reason: string): void {
      const turn = this.#inputTurns.get(connection.id);
      if (!turn) return;
      this.#inputTurns.delete(connection.id);
      turn.emit("turn.aborted", { reason });
      turn.finish("aborted");
    }

    #beginTurnDiagnostics(
      connection: Connection,
      source: "speech" | "text",
      turn = this.#createTurn(connection, source)
    ): ActiveTurnDiagnostics {
      const previous = this.#activeTurnDiagnostics.get(connection.id);
      if (previous) {
        previous.turn.emit("turn.abort_requested", { reason: "replaced" });
        previous.model?.abort();
      }

      const signal = this.#cm.createPipelineAbort(connection.id);
      const active: ActiveTurnDiagnostics = { signal, turn };
      this.#activeTurnDiagnostics.set(connection.id, active);
      return active;
    }

    #requestActiveTurnAbort(
      connection: Connection,
      event: "turn.abort_requested" | "turn.interrupt_requested",
      reason: string
    ): void {
      const active = this.#activeTurnDiagnostics.get(connection.id);
      if (!active) return;
      active.turn.emit(event, { reason });
      active.model?.abort();
    }

    #clearActiveTurn(
      connectionId: string,
      active: ActiveTurnDiagnostics
    ): void {
      if (this.#activeTurnDiagnostics.get(connectionId) === active) {
        this.#activeTurnDiagnostics.delete(connectionId);
      }
    }

    #emitTurnDiagnostic(
      connection: Connection,
      turn: TurnDiagnostics | undefined,
      event: string,
      data?: DiagnosticData
    ): void {
      if (turn) {
        turn.emit(event, data);
      } else {
        this.#diagnose(connection, event, data);
      }
    }

    // --- Internal: text message handling ---

    async #handleTextMessage(connection: Connection, text: string) {
      if (!text || text.trim().length === 0) return;

      const userText = text.trim();
      const pipelineStart = Date.now();
      const active = this.#beginTurnDiagnostics(connection, "text");
      const { signal, turn } = active;
      let turnOutcome: VoiceTurnOutcome = "completed";

      this.#sendJSON(connection, { type: "status", status: "thinking" });

      const priorMessages = this.getConversationHistory();
      this.saveMessage("user", userText);
      this.#sendJSON(connection, {
        type: "transcript",
        role: "user",
        text: userText
      });

      try {
        const context: VoiceTurnContext = {
          connection,
          messages: priorMessages,
          signal
        };

        const model = turn.startModel();
        active.model = model;
        const turnResult = await this.onTurn(userText, context);

        console.log("[VoiceTrace]", {
          event: "onTurn_call",
          connectionId: connection.id,
          text: userText,
          history: context.messages
        });

        if (signal.aborted) return;

        const isInCall = this.#cm.isInCall(connection.id);

        if (isInCall) {
          const { text: fullText, finishReason } = await this.#streamResponse(
            connection,
            turnResult,
            pipelineStart,
            signal,
            turn,
            model
          );

          if (signal.aborted) return;

          const hasOutput = fullText.trim().length > 0;
          turnOutcome = stableTurnOutcome(finishReason, hasOutput);
          if (turnOutcome === "completed" && turn.hasTtsFailures) {
            turnOutcome = "tts_error";
          }
          if (hasOutput) {
            this.#cm.updateAgentContext(connection.id, fullText);
            this.saveMessage("assistant", fullText);
          }
          const completionOutcome = createCompletionOutcome(
            finishReason,
            hasOutput
          );
          if (completionOutcome) {
            this.#sendJSON(connection, {
              type: "completion_outcome",
              ...completionOutcome
            });
          }
          if (!hasOutput) {
            this.#sendJSON(connection, {
              type: "error",
              message: "No response generated"
            });
          }
          this.#sendJSON(connection, { type: "status", status: "listening" });
        } else {
          let fullText = "";
          let pendingText = "";
          let transcriptStarted = false;

          const sendAssistantDelta = (token: string) => {
            if (!transcriptStarted) {
              pendingText += token;
              if (pendingText.trim().length === 0) return;

              this.#sendJSON(connection, {
                type: "transcript_start",
                role: "assistant"
              });
              transcriptStarted = true;
              token = pendingText;
              pendingText = "";
            }

            this.#sendJSON(connection, {
              type: "transcript_delta",
              text: token
            });
          };

          let finishReason: VoiceModelFinishReason | undefined;
          for await (const event of iterateTextEvents(turnResult)) {
            if (signal.aborted) break;
            model.observe(event);
            if (event.type === "finish") {
              finishReason = event.finishReason;
            } else if (event.type === "error") {
              if (transcriptStarted) {
                this.#sendJSON(connection, {
                  type: "transcript_end",
                  text: fullText
                });
              }
              throw new ModelStreamError(
                event.error,
                fullText.trim().length > 0
              );
            } else if (event.type === "text") {
              fullText += event.text;
              sendAssistantDelta(event.text);
            }
          }

          const hasOutput = fullText.trim().length > 0;
          model.complete(hasOutput ? "output" : "no_output", finishReason);
          turnOutcome = stableTurnOutcome(finishReason, hasOutput);
          if (hasOutput) {
            if (transcriptStarted) {
              this.#sendJSON(connection, {
                type: "transcript_end",
                text: fullText
              });
            }
            this.saveMessage("assistant", fullText);
          }
          const completionOutcome = createCompletionOutcome(
            finishReason,
            hasOutput
          );
          if (completionOutcome) {
            this.#sendJSON(connection, {
              type: "completion_outcome",
              ...completionOutcome
            });
          }
          if (!hasOutput) {
            this.#sendJSON(connection, {
              type: "error",
              message: "No response generated"
            });
          }
          this.#sendJSON(connection, { type: "status", status: "idle" });
        }
      } catch (error) {
        if (signal.aborted) return;
        turnOutcome =
          error instanceof ModelStreamError
            ? "model_error"
            : turn.hasTtsFailures
              ? "tts_error"
              : "error";
        const pipelineError =
          error instanceof ModelStreamError
            ? error.streamError
            : toVoiceError(error, "Text turn failed");
        active.model?.fail(pipelineError);
        turn.emit("turn.error", {
          stage: error instanceof ModelStreamError ? "model" : "pipeline",
          error: pipelineError
        });
        if (error instanceof ModelStreamError) {
          this.#sendJSON(connection, {
            type: "completion_outcome",
            code: "model_error",
            stage: "llm",
            partialOutput: error.partialOutput
          });
        }
        logVoiceError({
          component: "VoiceAgent",
          stage: "text_pipeline",
          message: "Text pipeline failed",
          connectionId: connection.id,
          error: pipelineError
        });
        this.#sendJSON(connection, {
          type: "error",
          message: voiceErrorMessage(pipelineError, "Text pipeline failed")
        });
        this.#sendJSON(connection, {
          type: "status",
          status: this.#cm.isInCall(connection.id) ? "listening" : "idle"
        });
      } finally {
        if (signal.aborted) {
          turnOutcome = "aborted";
          active.model?.abort();
          turn.emit("turn.aborted");
        }
        turn.finish(turnOutcome);
        this.#cm.clearPipelineAbort(connection.id, signal);
        this.#clearActiveTurn(connection.id, active);
      }
    }

    // --- Voice pipeline ---

    async #runPipeline(
      connection: Connection,
      transcript: string,
      turn: TurnDiagnostics,
      speculative?: SpeculativeTurn
    ) {
      const pipelineStart = Date.now();
      const active = this.#beginTurnDiagnostics(connection, "speech", turn);
      const { signal } = active;
      let turnOutcome: VoiceTurnOutcome = "completed";

      try {
        const afterTranscribeStart = Date.now();
        let userText: string | null;
        try {
          userText = await this.afterTranscribe(transcript, connection);
        } catch (error) {
          if (!speculative) throw error;
          const confirmed = await speculative.outcome;
          if (!confirmed) return;
          throw error;
        }
        turn.recordAfterTranscribe(
          Date.now() - afterTranscribeStart,
          userText ? "accepted" : "skipped",
          userText?.length ?? 0
        );
        if (signal.aborted) return;
        if (!userText) {
          if (speculative) {
            const confirmed = await speculative.outcome;
            if (!confirmed) return;
          }
          turnOutcome = "skipped";
          this.#sendJSON(connection, { type: "status", status: "listening" });
          return;
        }
        if (speculative) speculative.pipelineStarted = true;

        const priorMessages = this.getConversationHistory();
        if (!speculative) {
          this.saveMessage("user", userText);
          this.#sendJSON(connection, {
            type: "transcript",
            role: "user",
            text: userText
          });
          this.#sendJSON(connection, { type: "status", status: "thinking" });
        }

        const context: VoiceTurnContext = {
          connection,
          messages: priorMessages,
          signal
        };

        const model = turn.startModel();
        active.model = model;
        const pendingTurnResult = Promise.resolve()
          .then(() => this.onTurn(userText, context))
          .then(
            (value) => ({ ok: true as const, value }),
            (error: unknown) => ({ ok: false as const, error })
          );

        console.log("[VoiceTrace]", {
          event: "onTurn_call",
          connectionId: connection.id,
          text: userText,
          history: context.messages
        });

        if (speculative) {
          const confirmed = await speculative.outcome;
          if (!confirmed) return;
          this.saveMessage("user", userText);
          this.#sendJSON(connection, {
            type: "transcript",
            role: "user",
            text: userText
          });
          if (signal.aborted) return;
          this.#sendJSON(connection, { type: "status", status: "thinking" });
        }

        const settledTurnResult = await pendingTurnResult;
        if (!settledTurnResult.ok) {
          if (signal.aborted) return;
          throw settledTurnResult.error;
        }
        const turnResult = settledTurnResult.value;

        if (signal.aborted) return;

        const {
          text: fullText,
          llmMs,
          ttsMs,

          firstAudioMs,
          finishReason
        } = await this.#streamResponse(
          connection,
          turnResult,
          pipelineStart,
          signal,
          turn,
          model
        );

        if (signal.aborted) return;

        const hasOutput = fullText.trim().length > 0;
        turnOutcome = stableTurnOutcome(finishReason, hasOutput);
        if (turnOutcome === "completed" && turn.hasTtsFailures) {
          turnOutcome = "tts_error";
        }
        if (!hasOutput) {
          const completionOutcome = createCompletionOutcome(
            finishReason,
            false
          );
          this.#sendJSON(connection, {
            type: "completion_outcome",
            ...completionOutcome
          });
          this.#sendJSON(connection, {
            type: "error",
            message: "No response generated"
          });
          this.#sendJSON(connection, { type: "status", status: "listening" });
          return;
        }

        const completionOutcome = createCompletionOutcome(finishReason, true);
        if (completionOutcome) {
          this.#sendJSON(connection, {
            type: "completion_outcome",
            ...completionOutcome
          });
        }

        const totalMs = Date.now() - pipelineStart;

        this.#sendJSON(connection, {
          type: "metrics",
          llm_ms: llmMs,
          tts_ms: ttsMs,
          first_audio_ms: firstAudioMs,
          total_ms: totalMs
        });

        // Feed the agent's spoken reply back to the transcriber as context for
        // the user's next turn (no-op for providers without context carryover).
        this.#cm.updateAgentContext(connection.id, fullText);
        this.saveMessage("assistant", fullText);
        this.#sendJSON(connection, { type: "status", status: "listening" });
      } catch (error) {
        if (signal.aborted) return;
        turnOutcome =
          error instanceof ModelStreamError
            ? "model_error"
            : turn.hasTtsFailures
              ? "tts_error"
              : "error";
        const pipelineError =
          error instanceof ModelStreamError
            ? error.streamError
            : toVoiceError(error, "Voice turn failed");
        active.model?.fail(pipelineError);
        turn.emit("turn.error", {
          stage: error instanceof ModelStreamError ? "model" : "pipeline",
          error: pipelineError
        });
        if (error instanceof ModelStreamError) {
          this.#sendJSON(connection, {
            type: "completion_outcome",
            code: "model_error",
            stage: "llm",
            partialOutput: error.partialOutput
          });
        }
        logVoiceError({
          component: "VoiceAgent",
          stage: "pipeline",
          message: "Voice pipeline failed",
          connectionId: connection.id,
          error: pipelineError
        });
        this.#sendJSON(connection, {
          type: "error",
          message: voiceErrorMessage(pipelineError, "Voice pipeline failed")
        });
        this.#sendJSON(connection, { type: "status", status: "listening" });
      } finally {
        if (this.#activeAssistantText.get(connection.id)?.signal === signal) {
          this.#activeAssistantText.delete(connection.id);
        }
        if (signal.aborted) {
          turnOutcome = "aborted";
          active.model?.abort();
          turn.emit("turn.aborted");
        }
        turn.finish(turnOutcome);
        this.#cm.clearPipelineAbort(connection.id, signal);
        this.#clearActiveTurn(connection.id, active);
      }
    }

    // --- Streaming TTS ---

    async #streamResponse(
      connection: Connection,
      response: TextSource,
      pipelineStart: number,
      signal: AbortSignal,
      turn: TurnDiagnostics,
      model: ModelDiagnosticTracker
    ): Promise<{
      text: string;
      llmMs: number;
      ttsMs: number;
      firstModelDeltaMs: number;
      firstSentenceMs: number;
      firstAudioMs: number;
      finishReason?: VoiceModelFinishReason;
    }> {
      const clientMarkers = this.#clientPlaybackMarkers.get(connection.id);
      clientMarkers?.markers.clear();
      clientMarkers?.acknowledgedMarkers.clear();
      if (clientMarkers) clientMarkers.acknowledgedText.length = 0;
      const markedTransport = playbackTextTransport(
        this.#audioTransports.get(connection.id)
      );
      markedTransport?.resetPlaybackText(connection.id);

      if (typeof response === "string") {
        this.#activeAssistantText.set(connection.id, {
          signal,
          text: response
        });
        const llmMs = model.elapsedMs();

        if (response.trim().length === 0) {
          model.complete("no_output");
          return {
            text: response,
            llmMs,
            ttsMs: 0,
            firstModelDeltaMs: 0,
            firstSentenceMs: 0,
            firstAudioMs: 0
          };
        }

        model.observe({ type: "text", text: response });
        model.complete("output");
        this.#sendJSON(connection, {
          type: "transcript_start",
          role: "assistant"
        });
        this.#sendJSON(connection, {
          type: "transcript_end",
          text: response
        });

        const ttsStart = Date.now();
        let audio: ArrayBuffer | null;
        try {
          audio = await this.#synthesizeWithHooks(
            response,
            connection,
            undefined,
            turn
          );
        } finally {
          turn.finishTts();
        }
        const ttsMs = Date.now() - ttsStart;

        let firstAudioMs = 0;
        if (audio && !signal.aborted) {
          this.#sendJSON(connection, { type: "status", status: "speaking" });
          firstAudioMs = Date.now() - pipelineStart;
          turn.emit("audio.first_sent", {
            bytes: audio.byteLength,
            elapsed_ms: firstAudioMs
          });
          turn.audioSent();
          await this.#sendAudio(connection, audio);
          turn.emit("audio.completed", {
            bytes: audio.byteLength
          });
        }
        if (!signal.aborted) await this.#flushAudio(connection);

        return {
          text: response,
          llmMs,
          ttsMs,
          firstModelDeltaMs: llmMs,
          firstSentenceMs: llmMs,
          firstAudioMs
        };
      }

      const tts = this.#requireTTS() as TTSProvider &
        Partial<StreamingTextTTSProvider>;
      try {
        if (
          markedTransport ||
          this.#playbackMarkerConnections.has(connection.id)
        ) {
          return await this.#streamingTTSPipeline(
            connection,
            iterateTextEvents(response),
            pipelineStart,
            signal,
            turn,
            model,
            markedTransport
          );
        }
        if (typeof tts.synthesizeTextStream === "function") {
          return await this.#textStreamingTTSPipeline(
            connection,
            iterateTextEvents(response),
            pipelineStart,
            signal,
            tts as TTSProvider & StreamingTextTTSProvider,
            turn,
            model
          );
        }
        return await this.#streamingTTSPipeline(
          connection,
          iterateTextEvents(response),
          pipelineStart,
          signal,
          turn,
          model,
          markedTransport
        );
      } finally {
        turn.finishTts();
      }
    }

    async #textStreamingTTSPipeline(
      connection: Connection,
      tokenStream: AsyncIterable<TextStreamEvent>,
      pipelineStart: number,
      signal: AbortSignal,
      tts: TTSProvider & StreamingTextTTSProvider,
      turn: TurnDiagnostics,
      model: ModelDiagnosticTracker
    ): Promise<{
      text: string;
      llmMs: number;
      ttsMs: number;
      firstModelDeltaMs: number;
      firstSentenceMs: number;
      firstAudioMs: number;
      finishReason?: VoiceModelFinishReason;
    }> {
      const textStream = new TransformStream<string, string>();
      const writer = textStream.writable.getWriter();
      const ttsAttempt = turn.beginTtsSentence();
      const ttsStartedAt = Date.now();
      let ttsOutcome: "completed" | "failed" = "completed";
      let ttsMs = 0;
      let fullText = "";
      let pendingTranscriptText = "";
      let transcriptStarted = false;
      let firstModelDeltaAt: number | null = null;
      let firstAudioSentAt: number | null = null;
      let totalAudioBytes = 0;
      let finishReason: VoiceModelFinishReason | undefined;

      turn.emit("tts.started", { mode: "text_streaming" });
      ttsAttempt.providerStarted();

      const sendAssistantDelta = (token: string) => {
        if (!transcriptStarted) {
          pendingTranscriptText += token;
          if (pendingTranscriptText.trim().length === 0) return;
          this.#sendJSON(connection, {
            type: "transcript_start",
            role: "assistant"
          });
          transcriptStarted = true;
          token = pendingTranscriptText;
          pendingTranscriptText = "";
        }
        this.#sendJSON(connection, { type: "transcript_delta", text: token });
      };

      const audioPromise = (async () => {
        for await (const chunk of tts.synthesizeTextStream(
          textStream.readable,
          signal
        )) {
          if (signal.aborted) return;
          if (firstAudioSentAt === null) {
            this.#sendJSON(connection, { type: "status", status: "speaking" });
            firstAudioSentAt = Date.now();
            turn.emit("audio.first_sent", {
              bytes: chunk.byteLength,
              elapsed_ms: firstAudioSentAt - pipelineStart
            });
          }
          totalAudioBytes += chunk.byteLength;
          turn.audioSent();
          await this.#sendAudio(connection, chunk);
        }
      })();

      try {
        for await (const event of tokenStream) {
          if (signal.aborted) break;
          model.observe(event);
          if (event.type === "boundary") continue;
          if (event.type === "finish") {
            finishReason = event.finishReason;
            continue;
          }
          if (event.type === "error") {
            throw new ModelStreamError(event.error, fullText.trim().length > 0);
          }
          if (event.type !== "text") continue;

          if (firstModelDeltaAt === null) firstModelDeltaAt = Date.now();
          fullText += event.text;
          this.#activeAssistantText.set(connection.id, {
            signal,
            text: fullText
          });
          sendAssistantDelta(event.text);
          await writer.write(event.text);
        }

        if (signal.aborted) {
          await writer.abort(signal.reason).catch(() => undefined);
        } else {
          await writer.close();
        }
        await audioPromise;
      } catch (error) {
        ttsOutcome = "failed";
        await writer.abort(error).catch(() => undefined);
        await audioPromise.catch(() => undefined);
        throw error;
      } finally {
        ttsMs = ttsAttempt.settle(ttsOutcome);
        turn.emit("tts.completed", {
          duration_ms: Date.now() - ttsStartedAt,
          outcome:
            ttsOutcome === "failed"
              ? "failed"
              : totalAudioBytes > 0
                ? "audio"
                : "no_audio",
          bytes: totalAudioBytes
        });
        if (totalAudioBytes > 0) {
          turn.emit("audio.completed", { bytes: totalAudioBytes });
        }
        if (transcriptStarted) {
          this.#sendJSON(connection, {
            type: "transcript_end",
            text: fullText
          });
        }
        if (!signal.aborted) await this.#flushAudio(connection);
      }

      const llmMs = model.elapsedMs();
      model.complete(
        fullText.trim().length > 0 ? "output" : "no_output",
        finishReason
      );
      return {
        text: fullText,
        llmMs,
        ttsMs,
        firstModelDeltaMs: firstModelDeltaAt
          ? firstModelDeltaAt - pipelineStart
          : 0,
        firstSentenceMs: firstModelDeltaAt
          ? firstModelDeltaAt - pipelineStart
          : 0,
        firstAudioMs: firstAudioSentAt ? firstAudioSentAt - pipelineStart : 0,
        ...(finishReason === undefined ? {} : { finishReason })
      };
    }

    async #streamingTTSPipeline(
      connection: Connection,
      tokenStream: AsyncIterable<TextStreamEvent>,
      pipelineStart: number,
      signal: AbortSignal,
      turn: TurnDiagnostics,
      model: ModelDiagnosticTracker,
      markedTransport: PlaybackTextTransport | null
    ): Promise<{
      text: string;
      llmMs: number;
      ttsMs: number;
      firstModelDeltaMs: number;
      firstSentenceMs: number;
      firstAudioMs: number;
      finishReason?: VoiceModelFinishReason;
    }> {
      const tts = this.#requireTTS();
      const chunker = new SentenceChunker(
        typeof tts.synthesizeStream === "function"
          ? STREAMING_TTS_MAX_CHARS
          : Number.POSITIVE_INFINITY
      );
      const ttsQueue: AsyncIterable<TTSOutputEvent>[] = [];
      const playbackId = crypto.randomUUID();
      let nextSequence = 0;
      let fullText = "";
      let pendingTranscriptText = "";
      let transcriptStarted = false;
      let firstAudioSentAt: number | null = null;
      let firstModelDeltaAt: number | null = null;
      let firstSentenceAt: number | null = null;
      let firstTtsStartedAt: number | null = null;
      let cumulativeTtsMs = 0;
      let totalAudioBytes = 0;
      let skippedSentences = 0;
      let ttsFailures = 0;
      let finishReason: VoiceModelFinishReason | undefined;

      let streamComplete = false;
      let drainNotify: (() => void) | null = null;
      let drainPending = false;
      let drainedCount = 0;
      const drainWaiters = new Map<number, (() => void)[]>();

      const notifyDrain = () => {
        if (drainNotify) {
          const resolve = drainNotify;
          drainNotify = null;
          resolve();
        } else {
          drainPending = true;
        }
      };

      const notifyDrained = () => {
        for (const [target, waiters] of drainWaiters) {
          if (drainedCount < target) continue;
          drainWaiters.delete(target);
          for (const resolve of waiters) resolve();
        }
      };

      const waitForDrained = (target: number): Promise<void> => {
        if (drainedCount >= target) return Promise.resolve();

        return new Promise<void>((resolve) => {
          const waiters = drainWaiters.get(target) ?? [];
          waiters.push(resolve);
          drainWaiters.set(target, waiters);
        });
      };

      const drainPromise = (async () => {
        let i = 0;
        while (true) {
          while (i >= ttsQueue.length) {
            if (streamComplete && i >= ttsQueue.length) return;
            if (drainPending) {
              drainPending = false;
              continue;
            }
            await new Promise<void>((r) => {
              drainNotify = r;
            });
            if (streamComplete && i >= ttsQueue.length) return;
          }

          if (signal.aborted) return;

          try {
            for await (const event of ttsQueue[i]) {
              if (signal.aborted) return;
              if (event.type === "playback_marker") {
                markedTransport?.markPlaybackText(connection.id, event.text);
                if (this.#playbackMarkerConnections.has(connection.id)) {
                  const marker: VoicePlaybackMarkerMessage = {
                    type: "playback_marker",
                    playbackId: event.playbackId,
                    sequence: event.sequence,
                    text: event.text
                  };
                  const state = this.#clientPlaybackMarkers.get(connection.id);
                  state?.markers.set(
                    playbackMarkerKey(marker.playbackId, marker.sequence),
                    marker.text
                  );
                  this.#sendJSON(connection, marker);
                }
                continue;
              }
              const chunk = event.audio;
              if (firstAudioSentAt === null) {
                this.#sendJSON(connection, {
                  type: "status",
                  status: "speaking"
                });
                firstAudioSentAt = Date.now();
                turn.emit("audio.first_sent", {
                  bytes: chunk.byteLength,
                  elapsed_ms: firstAudioSentAt - pipelineStart
                });
              }
              totalAudioBytes += chunk.byteLength;
              turn.audioSent();
              await this.#sendAudio(connection, chunk);
            }
          } catch (error) {
            if (signal.aborted) return;
            const voiceError = toVoiceError(error, "TTS sentence failed");
            ttsFailures++;
            turn.emit("tts.failed", { error: voiceError });
            logVoiceError({
              component: "VoiceAgent",
              stage: "tts",
              message: "TTS failed for a sentence",
              connectionId: connection.id,
              error: voiceError
            });
            this.#sendJSON(connection, {
              type: "error",
              message: voiceErrorMessage(
                voiceError,
                "TTS failed for a sentence"
              )
            });
          }
          i++;
          drainedCount = i;
          notifyDrained();
        }
      })();
      const makeSentenceTTS = (
        sentence: string,
        sequence: number
      ): AsyncIterable<TTSOutputEvent> => {
        const self = this;
        async function* generate(): AsyncGenerator<TTSOutputEvent> {
          const attempt = turn.beginTtsSentence();
          let sentenceOutcome: "completed" | "skipped" | "failed" = "completed";
          let text: string | null = null;
          try {
            text = await self.beforeSynthesize(sentence, connection);
            if (!text) {
              sentenceOutcome = "skipped";
              skippedSentences++;
              return;
            }

            const hasStreamingTTS = typeof tts.synthesizeStream === "function";
            if (firstTtsStartedAt === null) {
              firstTtsStartedAt = Date.now();
              turn.emit("tts.started", {
                mode: hasStreamingTTS ? "streaming" : "buffered",
                characters: text.length
              });
            }
            attempt.providerStarted();
            console.log("[VoiceTrace]", {
              event: "tts_enqueued",
              connectionId: connection.id,
              elapsedMs: Date.now() - pipelineStart,
              playbackId,
              sequence,
              text
            });
            let yieldedAudio = false;
            if (hasStreamingTTS) {
              for await (const chunk of tts.synthesizeStream!(text, signal)) {
                const processed = await self.afterSynthesize(
                  chunk,
                  text,
                  connection
                );
                if (processed) {
                  yieldedAudio = true;
                  yield { type: "audio", audio: processed };
                }
              }
            } else {
              const rawAudio = await tts.synthesize(text, signal);
              const processed = await self.afterSynthesize(
                rawAudio,
                text,
                connection
              );
              if (processed) {
                yieldedAudio = true;
                yield { type: "audio", audio: processed };
              }
            }
            if (yieldedAudio && !signal.aborted) {
              yield { type: "playback_marker", playbackId, sequence, text };
            }
          } catch (error) {
            sentenceOutcome = "failed";
            throw error;
          } finally {
            cumulativeTtsMs += attempt.settle(sentenceOutcome);
          }
        }
        return markedTransport ? generate() : eagerAsyncIterable(generate());
      };

      const enqueueSentence = (sentence: string) => {
        firstSentenceAt ??= Date.now();
        const sequence = ++nextSequence;
        ttsQueue.push(makeSentenceTTS(sentence, sequence));
        notifyDrain();
      };

      const sendAssistantDelta = (token: string) => {
        if (!transcriptStarted) {
          pendingTranscriptText += token;
          if (pendingTranscriptText.trim().length === 0) return;

          this.#sendJSON(connection, {
            type: "transcript_start",
            role: "assistant"
          });
          transcriptStarted = true;
          token = pendingTranscriptText;
          pendingTranscriptText = "";
        }

        this.#sendJSON(connection, { type: "transcript_delta", text: token });
      };

      for await (const event of tokenStream) {
        if (signal.aborted) break;
        model.observe(event);

        if (event.type === "boundary") {
          for (const sentence of chunker.flush()) {
            enqueueSentence(sentence);
          }
          await waitForDrained(ttsQueue.length);
          continue;
        }

        if (event.type === "finish") {
          finishReason = event.finishReason;
          continue;
        }

        if (event.type === "error") {
          for (const sentence of chunker.flush()) {
            enqueueSentence(sentence);
          }
          await waitForDrained(ttsQueue.length);
          if (transcriptStarted) {
            this.#sendJSON(connection, {
              type: "transcript_end",
              text: fullText
            });
          }
          streamComplete = true;
          notifyDrain();
          await drainPromise;
          throw new ModelStreamError(event.error, fullText.trim().length > 0);
        }

        if (event.type !== "text") continue;
        const token = event.text;
        if (firstModelDeltaAt === null) {
          firstModelDeltaAt = Date.now();
        }

        fullText += token;
        this.#activeAssistantText.set(connection.id, {
          signal,
          text: fullText
        });
        sendAssistantDelta(token);

        const sentences = chunker.add(token);
        for (const sentence of sentences) {
          enqueueSentence(sentence);
        }
      }

      const llmMs = model.elapsedMs();
      model.complete(
        fullText.trim().length > 0 ? "output" : "no_output",
        finishReason
      );

      const remaining = chunker.flush();
      for (const sentence of remaining) {
        enqueueSentence(sentence);
      }

      streamComplete = true;
      notifyDrain();
      if (transcriptStarted) {
        this.#sendJSON(connection, { type: "transcript_end", text: fullText });
      }

      await drainPromise;
      if (!signal.aborted) await this.#flushAudio(connection);

      if (firstTtsStartedAt === null) {
        turn.emit("tts.skipped", {
          reason:
            fullText.trim().length === 0
              ? "no_output"
              : ttsFailures > 0
                ? "preparation_failed"
                : "before_synthesize",
          sentences: skippedSentences,
          failures: ttsFailures
        });
      } else {
        turn.emit("tts.completed", {
          duration_ms: Date.now() - firstTtsStartedAt,
          outcome:
            totalAudioBytes > 0
              ? ttsFailures > 0
                ? "partial"
                : "audio"
              : ttsFailures > 0
                ? "failed"
                : "no_audio",
          bytes: totalAudioBytes,
          failures: ttsFailures,
          skipped_sentences: skippedSentences
        });
      }
      if (totalAudioBytes > 0) {
        turn.emit("audio.completed", {
          bytes: totalAudioBytes
        });
      }

      const firstAudioMs = firstAudioSentAt
        ? firstAudioSentAt - pipelineStart
        : 0;
      const firstModelDeltaMs = firstModelDeltaAt
        ? firstModelDeltaAt - pipelineStart
        : 0;
      const firstSentenceMs = firstSentenceAt
        ? firstSentenceAt - pipelineStart
        : 0;

      return {
        text: fullText,
        llmMs,
        ttsMs: cumulativeTtsMs,
        firstModelDeltaMs,
        firstSentenceMs,
        firstAudioMs,
        ...(finishReason === undefined ? {} : { finishReason })
      };
    }

    // --- Protocol helpers ---

    #diagnose(
      connection: Connection,
      event: string,
      data?: DiagnosticData
    ): void {
      diagnostics.emit(connection, event, data);
    }

    #sendJSON(connection: Connection, data: unknown) {
      const parsed = data as Record<string, unknown>;
      if (
        (parsed.type === "transcript" ||
          parsed.type === "transcript_interim" ||
          parsed.type === "transcript_end") &&
        typeof parsed.text === "string"
      ) {
        console.log("[VoiceTrace]", {
          event:
            parsed.type === "transcript_interim"
              ? "client_transcript_interim"
              : "client_transcript",
          connectionId: connection.id,
          role: parsed.type === "transcript_end" ? "assistant" : "user",
          text: parsed.text
        });
      }
      sendVoiceJSON(
        connection,
        data,
        "VoiceAgent",
        parsed.type === "transcript_delta"
      );
    }
  }

  return VoiceAgentMixin as unknown as VoiceAgentMixinReturn<TBase>;
}

// --- Eager async iterable ---

function eagerAsyncIterable<T>(source: AsyncIterable<T>): AsyncIterable<T> {
  const buffer: T[] = [];
  let finished = false;
  let error: unknown = null;
  let waitResolve: (() => void) | null = null;

  const notify = () => {
    if (waitResolve) {
      const resolve = waitResolve;
      waitResolve = null;
      resolve();
    }
  };

  (async () => {
    try {
      for await (const item of source) {
        buffer.push(item);
        notify();
      }
    } catch (err) {
      error = err;
    } finally {
      finished = true;
      notify();
    }
  })();

  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        async next(): Promise<IteratorResult<T>> {
          while (index >= buffer.length && !finished) {
            await new Promise<void>((r) => {
              waitResolve = r;
            });
          }
          if (error) {
            throw error;
          }
          if (index >= buffer.length) {
            return { done: true, value: undefined };
          }
          return { done: false, value: buffer[index++] };
        }
      };
    }
  };
}

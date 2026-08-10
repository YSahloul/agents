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
 * interruption handling, conversation persistence, and the WebSocket
 * voice protocol. The transcriber session is per-call — created at
 * start_call, closed at end_call. The model handles turn detection.
 *
 * @experimental This API is not yet stable and may change.
 */

import type { Agent, Connection, WSMessage } from "agents";
import { SentenceChunker } from "./sentence-chunker";
import {
  iterateText,
  iterateTextEvents,
  type TextSource,
  type TextStreamEvent
} from "./text-stream";
import { VOICE_PROTOCOL_VERSION } from "./types";
import type {
  RealtimeTTSProvider,
  RealtimeTTSSession,
  VoiceRole,
  VoiceAudioFormat,
  TTSProvider,
  StreamingTTSProvider,
  Transcriber,
  TranscriberSession,
  VoiceServerAudioTransport
} from "./types";
import {
  AudioConnectionManager,
  runBackground,
  sendVoiceJSON
} from "./audio-pipeline";

// Re-export SentenceChunker for direct use
export { SentenceChunker } from "./sentence-chunker";

// Re-export protocol version constant
export { VOICE_PROTOCOL_VERSION } from "./types";

export type {
  VoiceStatus,
  VoiceRole,
  VoiceAudioFormat,
  VoiceAudioInput,
  VoiceTransport,
  VoiceServerAudioTransport,
  VoiceClientMessage,
  VoiceServerMessage,
  VoicePipelineMetrics,
  TranscriptMessage,
  TTSProvider,
  StreamingTTSProvider,
  RealtimeTTSProvider,
  RealtimeTTSSession,
  RealtimeTTSSessionOptions,
  Transcriber,
  TranscriberSession,
  TranscriberSessionOptions
} from "./types";

// Re-export voice input mixin (STT-only, no TTS/LLM)
export { withVoiceInput } from "./voice-input";

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
  renegotiateSFUSession,
  createSFUWebSocketAdapter,
  closeSFUWebSocketAdapter
} from "./sfu-utils";
export type { SFUConfig } from "./sfu-utils";
export { SFUVoiceTransport } from "./sfu-transport";
export type { SFUVoiceState, SFUVoiceTransportOptions } from "./sfu-transport";
export { withSFUVoice } from "./sfu-voice";
export type { SFUVoiceAgentOptions } from "./sfu-voice";

// Re-export Workers AI providers
export {
  WorkersAITTS,
  WorkersAIMulawRealtimeTTS,
  WorkersAIFluxSTT,
  WorkersAINova3STT
} from "./workers-ai-providers";
export type {
  WorkersAITTSOptions,
  WorkersAIMulawRealtimeTTSOptions,
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
  /** Max conversation messages to keep in SQLite. Oldest are pruned. @default 1000 */
  maxMessageCount?: number;
}


interface SpeculativeTurn {
  finalTranscript?: string;
  outcome: Promise<boolean>;
  settle(confirmed: boolean): void;
}

const DEFAULT_HISTORY_LIMIT = 20;
const DEFAULT_MAX_MESSAGE_COUNT = 1000;
const DEFAULT_SAMPLE_RATE = 16000;
/** Minimum time between barge-ins per connection. Without this, a burst of
 * spurious `StartOfTurn` events (background noise, line static, a stray
 * syllable) can abort a turn the instant a new one starts — over and over —
 * so nothing ever gets a chance to finish. StartOfTurn has no confidence or
 * duration floor of its own; this is that floor. */
const BARGE_IN_COOLDOWN_MS = 750;

// --- Mixin ---

// oxlint-disable-next-line @typescript-eslint/no-explicit-any -- mixin constructor constraint
type Constructor<T = object> = new (...args: any[]) => T;

type AgentLike = Constructor<Agent<Cloudflare.Env>>;

/** Public surface of the voice mixin, used as an explicit return type to satisfy TS6 declaration emit. */
export interface VoiceAgentMixinMembers {
  transcriber?: Transcriber;
  tts?:
    | (TTSProvider &
        Partial<RealtimeTTSProvider> &
        Partial<StreamingTTSProvider>)
    | undefined;
  createTranscriber(connection: Connection): Transcriber | null;
  createAudioTransport(
    connection: Connection
  ):
    | VoiceServerAudioTransport
    | null
    | Promise<VoiceServerAudioTransport | null>;
  receiveAudio(connectionId: string, audio: ArrayBuffer): void;
  beforeCallStart(connection: Connection): boolean | Promise<boolean>;
  onCallStart(connection: Connection): void | Promise<void>;
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
    tts?: TTSProvider &
      Partial<RealtimeTTSProvider> &
      Partial<StreamingTTSProvider>;

    // Shared per-connection audio state manager
    #cm = new AudioConnectionManager("VoiceAgent");

    // keepAlive dispose functions per connection (prevents DO eviction during calls)
    #keepAliveDispose = new Map<string, () => void>();

    // Optional server audio transports keyed by their voice connection.
    #audioTransports = new Map<string, VoiceServerAudioTransport>();
    // Persistent text-to-speech sessions keyed by voice connection.
    #realtimeTTSSessions = new Map<string, RealtimeTTSSession>();
    #realtimeTTSText = new Map<string, string>();
    #firstRealtimeAudioAt = new Map<string, number>();
    // Speculative Flux responses wait for EndOfTurn before persistence.
    #speculativeTurns = new Map<string, SpeculativeTurn>();

    // Debounces barge-in: see BARGE_IN_COOLDOWN_MS.
    #lastBargeInAt = new Map<string, number>();

    // Current async start_call identity per connection, used to ignore stale readiness.
    #startupTokens = new Map<string, symbol>();

    // Voice protocol message types handled internally
    static #VOICE_MESSAGES = new Set([
      "hello",
      "start_call",
      "end_call",
      "start_of_speech",
      "end_of_speech",
      "interrupt",
      "text_message"
    ]);

    // --- Agent lifecycle ---

    #schemaReady = false;

    #ensureSchema() {
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
          protocol_version: VOICE_PROTOCOL_VERSION
        });
        this.#sendJSON(connection, { type: "status", status: "idle" });
        return _onConnect?.(connection, ...rest);
      };

      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- overwriting lifecycle
      (this as any).onClose = (connection: Connection, ...rest: unknown[]) => {
        this.#startupTokens.delete(connection.id);
        this.#releaseKeepAlive(connection.id);
        this.#cm.cleanup(connection.id);
        const transport = this.#audioTransports.get(connection.id);
        if (transport) {
          this.#audioTransports.delete(connection.id);
          runBackground("audio_transport_stop", () =>
            transport.stop(connection.id)
          );
        }
        const realtimeTTS = this.#realtimeTTSSessions.get(connection.id);
        if (realtimeTTS) {
          this.#realtimeTTSSessions.delete(connection.id);
          runBackground("realtime_tts_stop", () => realtimeTTS.close());
        }
        this.#cancelSpeculativeTurn(connection.id);
        this.#realtimeTTSText.delete(connection.id);
        this.#firstRealtimeAudioAt.delete(connection.id);
        this.#lastBargeInAt.delete(connection.id);
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

        let parsed: { type: string };
        try {
          parsed = JSON.parse(message);
        } catch {
          return _onMessage?.(connection, message);
        }

        if (VoiceAgentMixin.#VOICE_MESSAGES.has(parsed.type)) {
          switch (parsed.type) {
            case "hello":
              break;
            case "start_call":
              runBackground("start_call", () =>
                this.#handleStartCall(
                  connection,
                  (parsed as { preferred_format?: string }).preferred_format
                )
              );
              break;
            case "end_call":
              runBackground("end_call", () => this.#handleEndCall(connection));
              break;
            case "start_of_speech":
            case "end_of_speech":
              break;
            case "interrupt":
              runBackground("interrupt", () =>
                this.#handleInterrupt(connection)
              );
              break;
            case "text_message": {
              const text = (parsed as unknown as { text?: string }).text;
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
      this.#cm.bufferAudio(connectionId, audio);
    }

    beforeCallStart(_connection: Connection): boolean | Promise<boolean> {
      return true;
    }

    onCallStart(_connection: Connection): void | Promise<void> {}
    onCallEnd(_connection: Connection): void | Promise<void> {}
    onInterrupt(_connection: Connection): void | Promise<void> {}

    afterTranscribe(
      transcript: string,
      _connection: Connection
    ): string | null | Promise<string | null> {
      return transcript;
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

    // --- Conversation persistence ---

    saveMessage(role: "user" | "assistant", text: string) {
      this.#ensureSchema();
      this.sql`
        INSERT INTO cf_voice_messages (role, text, timestamp)
        VALUES (${role}, ${text}, ${Date.now()})
      `;

      const maxMessages = opt("maxMessageCount", DEFAULT_MAX_MESSAGE_COUNT);
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
      this.#ensureSchema();
      const historyLimit = limit ?? opt("historyLimit", DEFAULT_HISTORY_LIMIT);
      const rows = this.sql<{ role: VoiceRole; text: string }>`
        SELECT role, text FROM cf_voice_messages
        ORDER BY id DESC LIMIT ${historyLimit}
      `;
      return rows.reverse().map((row) => ({
        role: row.role,
        content: row.text
      }));
    }

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

    async #startRealtimeTTS(connection: Connection): Promise<void> {
      const tts = this.#requireTTS();
      if (typeof tts.createSession !== "function") return;

      let session: RealtimeTTSSession;
      session = tts.createSession({
        onAudio: (audio) => {
          if (this.#realtimeTTSSessions.get(connection.id) !== session) return;
          void this.#sendAudio(connection, audio);
          if (!this.#firstRealtimeAudioAt.has(connection.id)) {
            console.log("[VoiceTrace]", {
              event: "tts_first_audio",
              connectionId: connection.id,
              bytes: audio.byteLength
            });
            this.#firstRealtimeAudioAt.set(connection.id, Date.now());
          }
        },
        onError: (error) => {
          if (this.#realtimeTTSSessions.get(connection.id) !== session) return;
          console.error("[VoiceAgent] Realtime TTS error:", error);
        }
      });
      this.#realtimeTTSSessions.set(connection.id, session);
      try {
        await session.waitUntilReady?.();
      } catch (error) {
        this.#realtimeTTSSessions.delete(connection.id);
        await session.close();
        throw error;
      }
    }

    async #stopRealtimeTTS(connectionId: string): Promise<void> {
      const session = this.#realtimeTTSSessions.get(connectionId);
      if (!session) return;
      this.#realtimeTTSSessions.delete(connectionId);
      this.#realtimeTTSText.delete(connectionId);
      this.#firstRealtimeAudioAt.delete(connectionId);
      await session.close();
    }

    // --- Convenience methods ---


    #cancelSpeculativeTurn(connectionId: string): boolean {
      const turn = this.#speculativeTurns.get(connectionId);
      if (!turn) return false;
      this.#speculativeTurns.delete(connectionId);
      turn.settle(false);
      return true;
    }

    #startSpeculativeTurn(connection: Connection, transcript: string): void {
      if (this.#speculativeTurns.has(connection.id)) return;
      let settle: (confirmed: boolean) => void = () => {};
      const outcome = new Promise<boolean>((resolve) => {
        settle = resolve;
      });
      const turn: SpeculativeTurn = { outcome, settle };
      this.#speculativeTurns.set(connection.id, turn);
      this.#runPipeline(connection, transcript, turn);
    }
    forceEndCall(connection: Connection): void {
      if (!this.#cm.isInCall(connection.id)) return;
      runBackground("force_end_call", () => this.#handleEndCall(connection));
    }

    async speak(connection: Connection, text: string): Promise<void> {
      const signal = this.#cm.createPipelineAbort(connection.id);
      try {
        this.#sendJSON(connection, { type: "status", status: "speaking" });
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
          this.#sendJSON(connection, { type: "status", status: "speaking" });
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

    #requireTTS(): TTSProvider &
      Partial<RealtimeTTSProvider> &
      Partial<StreamingTTSProvider> {
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
      signal?: AbortSignal
    ): Promise<ArrayBuffer | null> {
      const textToSpeak = await this.beforeSynthesize(text, connection);
      if (!textToSpeak) return null;
      const rawAudio = await this.#requireTTS().synthesize(textToSpeak, signal);
      return this.afterSynthesize(rawAudio, textToSpeak, connection);
    }

    async #speakText(
      connection: Connection,
      text: string,
      signal: AbortSignal
    ): Promise<void> {
      const realtime = this.#realtimeTTSSessions.get(connection.id);
      if (realtime) {
        const textToSpeak = await this.beforeSynthesize(text, connection);
        if (!textToSpeak || signal.aborted) return;
        this.#realtimeTTSText.set(connection.id, textToSpeak);
        this.#firstRealtimeAudioAt.delete(connection.id);
        console.log("[VoiceTrace]", {
          event: "tts_speak_sent",
          connectionId: connection.id,
          chars: textToSpeak.length,
          text: textToSpeak
        });
        await realtime.speak(textToSpeak);
        await realtime.flush();
        if (!signal.aborted) await this.#flushAudio(connection);
        return;
      }

      const audio = await this.#synthesizeWithHooks(text, connection, signal);
      if (audio && !signal.aborted) await this.#sendAudio(connection, audio);
      if (!signal.aborted) await this.#flushAudio(connection);
    }

    // --- Internal: call lifecycle ---

    async #handleStartCall(connection: Connection, _preferredFormat?: string) {
      if (this.#cm.isInCall(connection.id)) return;

      const startupToken = Symbol(connection.id);
      this.#startupTokens.set(connection.id, startupToken);

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
          await transport.start(connection.id, (audio) =>
            this.receiveAudio(connection.id, audio)
          );
          if (!this.#isCurrentStartup(connection.id, startupToken)) return;
        }
        await this.#startRealtimeTTS(connection);
        if (!this.#isCurrentStartup(connection.id, startupToken)) return;
        provider = this.createTranscriber(connection) ?? this.transcriber;
        if (!provider) {
          const message =
            "No transcriber configured. Set 'transcriber' on your VoiceAgent subclass or override createTranscriber().";
          console.error(`[VoiceAgent] ${message}`);
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
          error,
          "Voice call failed to start"
        );
        return;
      }

      if (!provider) return;

      let session: TranscriberSession;
      try {
        session = this.#cm.startTranscriberSession(connection.id, provider, {
          onInterim: (text: string) => {
            this.#sendJSON(connection, {
              type: "transcript_interim",
              text
            });
          },
          onSpeechStart: () => {
            this.#handleBargeIn(connection);
          },
          onEagerUtterance: (transcript: string) => {
            this.#startSpeculativeTurn(connection, transcript);
          },
          onTurnResumed: () => {
            if (!this.#cancelSpeculativeTurn(connection.id)) return;
            this.#handleBargeIn(connection);
          },
          onUtterance: (transcript: string) => {
            console.log("[VoiceTrace]", {
              event: "stt_utterance",
              connectionId: connection.id,
              text: transcript
            });
            this.#sendJSON(connection, {
              type: "transcript_interim",
              text: ""
            });
            const speculative = this.#speculativeTurns.get(connection.id);
            if (speculative) {
              this.#speculativeTurns.delete(connection.id);
              speculative.finalTranscript = transcript;
              this.#sendJSON(connection, {
                type: "transcript",
                role: "user",
                text: transcript
              });
              speculative.settle(true);
              return;
            }
            this.#runPipeline(connection, transcript);
          }
        });

        await session.waitUntilReady?.();
      } catch (error) {
        await this.#handleTranscriberStartupFailure(
          connection,
          startupToken,
          error
        );
        return;
      }

      if (!this.#isCurrentStartup(connection.id, startupToken)) return;
      this.#startupTokens.delete(connection.id);

      this.#sendJSON(connection, { type: "status", status: "listening" });
      await this.onCallStart(connection);
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
      error: unknown
    ): Promise<void> {
      await this.#handleStartupFailure(
        connection,
        startupToken,
        error,
        "Speech recognition failed to start",
        "[VoiceAgent] Transcriber startup failed:"
      );
    }

    async #handleStartupFailure(
      connection: Connection,
      startupToken: symbol,
      error: unknown,
      clientMessage: string,
      logPrefix: string | null = "[VoiceAgent] Call startup failed:"
    ): Promise<void> {
      if (!this.#isCurrentStartup(connection.id, startupToken)) return;

      // The client starts local audio optimistically on start_call. Every
      // terminal startup path must send error + idle so it tears that down.
      if (logPrefix && error !== undefined) console.error(logPrefix, error);
      this.#startupTokens.delete(connection.id);
      this.#sendJSON(connection, {
        type: "error",
        message: clientMessage
      });
      try {
        await this.#stopRealtimeTTS(connection.id);
        await this.#stopAudioTransport(connection.id);
      } finally {
        this.#cm.cleanup(connection.id);
        this.#releaseKeepAlive(connection.id);
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
      this.#startupTokens.delete(connection.id);
      this.#cancelSpeculativeTurn(connection.id);
      this.#lastBargeInAt.delete(connection.id);
      try {
        await this.#stopRealtimeTTS(connection.id);
        await this.#stopAudioTransport(connection.id);
      } finally {
        this.#cm.cleanup(connection.id);
        this.#releaseKeepAlive(connection.id);
        this.#sendJSON(connection, { type: "status", status: "idle" });
        await this.onCallEnd(connection);
      }
    }

    async #handleInterrupt(connection: Connection): Promise<void> {
      console.log("[VoiceTrace]", {
        event: "interrupt",
        connectionId: connection.id
      });
      this.#cancelSpeculativeTurn(connection.id);
      this.#cm.abortPipeline(connection.id);
      this.#cm.clearAudioBuffer(connection.id);
      this.#sendJSON(connection, { type: "status", status: "listening" });
      try {
        await this.#realtimeTTSSessions.get(connection.id)?.clear();
        await this.#audioTransports
          .get(connection.id)
          ?.interrupt(connection.id);
      } finally {
        await this.onInterrupt(connection);
      }
    }

    #handleBargeIn(connection: Connection) {
      const now = Date.now();
      const lastBargeInAt = this.#lastBargeInAt.get(connection.id) ?? 0;
      if (now - lastBargeInAt < BARGE_IN_COOLDOWN_MS) return;
      if (!this.#cm.abortPipeline(connection.id)) return;
      this.#cancelSpeculativeTurn(connection.id);
      this.#lastBargeInAt.set(connection.id, now);
      console.log("[VoiceTrace]", {
        event: "barge_in",
        connectionId: connection.id
      });
      this.#sendJSON(connection, { type: "playback_interrupt" });
      this.#sendJSON(connection, { type: "status", status: "listening" });
      runBackground("barge_in", async () => {
        try {
          await this.#realtimeTTSSessions.get(connection.id)?.clear();
          await this.#audioTransports
            .get(connection.id)
            ?.interrupt(connection.id);
        } finally {
          await this.onInterrupt(connection);
        }
      });
    }

    // --- Internal: text message handling ---

    async #handleTextMessage(connection: Connection, text: string) {
      if (!text || text.trim().length === 0) return;

      const userText = text.trim();
      const signal = this.#cm.createPipelineAbort(connection.id);
      const pipelineStart = Date.now();

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

        const llmStart = Date.now();
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
          this.#sendJSON(connection, { type: "status", status: "speaking" });

          const { text: fullText } = await this.#streamResponse(
            connection,
            turnResult,
            llmStart,
            pipelineStart,
            signal
          );

          if (signal.aborted) return;

          if (fullText && fullText.trim().length > 0) {
            this.#cm.updateAgentContext(connection.id, fullText);
            this.saveMessage("assistant", fullText);
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

          for await (const token of iterateText(turnResult)) {
            if (signal.aborted) break;
            fullText += token;
            sendAssistantDelta(token);
          }

          if (fullText && fullText.trim().length > 0) {
            if (transcriptStarted) {
              this.#sendJSON(connection, {
                type: "transcript_end",
                text: fullText
              });
            }
            this.saveMessage("assistant", fullText);
          }
          this.#sendJSON(connection, { type: "status", status: "idle" });
        }
      } catch (error) {
        if (signal.aborted) return;
        console.error("[VoiceAgent] Text pipeline error:", error);
        this.#sendJSON(connection, {
          type: "error",
          message:
            error instanceof Error ? error.message : "Text pipeline failed"
        });
        this.#sendJSON(connection, {
          type: "status",
          status: this.#cm.isInCall(connection.id) ? "listening" : "idle"
        });
      } finally {
        this.#cm.clearPipelineAbort(connection.id, signal);
      }
    }

    // --- Internal: voice pipeline ---

    async #runPipeline(connection: Connection, transcript: string, speculative?: SpeculativeTurn) {
      const signal = this.#cm.createPipelineAbort(connection.id);
      const pipelineStart = Date.now();

      try {
        const userText = await this.afterTranscribe(transcript, connection);
        if (signal.aborted) return;
        if (!userText) {
          this.#sendJSON(connection, { type: "status", status: "listening" });
          return;
        }

        const priorMessages = this.getConversationHistory();
        if (!speculative) {
          this.saveMessage("user", userText);
          this.#sendJSON(connection, {
            type: "transcript",
            role: "user",
            text: userText
          });
        }

        this.#sendJSON(connection, { type: "status", status: "thinking" });

        const context: VoiceTurnContext = {
          connection,
          messages: priorMessages,
          signal
        };

        const llmStart = Date.now();
        const turnResult = await this.onTurn(userText, context);

        console.log("[VoiceTrace]", {
          event: "onTurn_call",
          connectionId: connection.id,
          text: userText,
          history: context.messages
        });

        if (signal.aborted) return;

        this.#sendJSON(connection, { type: "status", status: "speaking" });

        const {
          text: fullText,
          llmMs,
          ttsMs,
          firstModelDeltaMs,
          firstSentenceMs,
          firstAudioMs
        } = await this.#streamResponse(
          connection,
          turnResult,
          llmStart,
          pipelineStart,
          signal
        );

        if (signal.aborted) {
          if (!fullText || fullText.trim().length === 0) return;
          if (speculative) {
            const confirmed = await speculative.outcome;
            if (!confirmed) return;
            this.saveMessage("user", speculative.finalTranscript ?? userText);
          }
          this.#cm.updateAgentContext(connection.id, fullText);
          this.saveMessage("assistant", fullText);
          return;
        }

        if (!fullText || fullText.trim().length === 0) {
          this.#sendJSON(connection, {
            type: "error",
            message: "No response generated"
          });
          this.#sendJSON(connection, { type: "status", status: "listening" });
          return;
        }

        const totalMs = Date.now() - pipelineStart;

        if (speculative) {
          const confirmed = await speculative.outcome;
          if (!confirmed || signal.aborted) return;
          this.saveMessage("user", speculative.finalTranscript ?? userText);
        }

        this.#sendJSON(connection, {
          type: "metrics",
          llm_ms: llmMs,
          tts_ms: ttsMs,
          first_model_delta_ms: firstModelDeltaMs,
          first_sentence_ms: firstSentenceMs,
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
        console.error("[VoiceAgent] Pipeline error:", error);
        this.#sendJSON(connection, {
          type: "error",
          message:
            error instanceof Error ? error.message : "Voice pipeline failed"
        });
        this.#sendJSON(connection, { type: "status", status: "listening" });
      } finally {
        this.#cm.clearPipelineAbort(connection.id, signal);
      }
    }

    // --- Internal: streaming TTS pipeline ---

    async #streamResponse(
      connection: Connection,
      response: TextSource,
      llmStart: number,
      pipelineStart: number,
      signal: AbortSignal
    ): Promise<{
      text: string;
      llmMs: number;
      ttsMs: number;
      firstModelDeltaMs: number;
      firstSentenceMs: number;
      firstAudioMs: number;
    }> {
      const realtime = this.#realtimeTTSSessions.get(connection.id);
      if (realtime) {
        return this.#realtimeTTSPipeline(
          connection,
          realtime,
          iterateTextEvents(response),
          llmStart,
          pipelineStart,
          signal
        );
      }

      if (typeof response === "string") {
        const llmMs = Date.now() - llmStart;

        if (response.trim().length === 0) {
          return {
            text: response,
            llmMs,
            ttsMs: 0,
            firstModelDeltaMs: llmMs,
            firstSentenceMs: llmMs,
            firstAudioMs: 0
          };
        }

        this.#sendJSON(connection, {
          type: "transcript_start",
          role: "assistant"
        });
        this.#sendJSON(connection, {
          type: "transcript_end",
          text: response
        });

        const ttsStart = Date.now();
        const audio = await this.#synthesizeWithHooks(response, connection);
        const ttsMs = Date.now() - ttsStart;

        if (audio && !signal.aborted) {
          await this.#sendAudio(connection, audio);
        }
        if (!signal.aborted) await this.#flushAudio(connection);

        const firstAudioMs = Date.now() - pipelineStart;
        return {
          text: response,
          llmMs,
          ttsMs,
          firstModelDeltaMs: llmMs,
          firstSentenceMs: llmMs,
          firstAudioMs
        };
      }

      return this.#streamingTTSPipeline(
        connection,
        iterateTextEvents(response),
        llmStart,
        pipelineStart,
        signal
      );
    }

    async #realtimeTTSPipeline(
      connection: Connection,
      tts: RealtimeTTSSession,
      tokenStream: AsyncIterable<TextStreamEvent>,
      llmStart: number,
      pipelineStart: number,
      signal: AbortSignal
    ): Promise<{
      text: string;
      llmMs: number;
      ttsMs: number;
      firstModelDeltaMs: number;
      firstSentenceMs: number;
      firstAudioMs: number;
    }> {
      let fullText = "";
      let spokenText = "";
      let transcriptStarted = false;
      let firstModelDeltaAt: number | null = null;
      let firstTextSentAt: number | null = null;
      let ttsStartedAt: number | null = null;
      let hasPendingSpeech = false;
      this.#firstRealtimeAudioAt.delete(connection.id);

      const trace = (event: string, details: Record<string, unknown> = {}) => {
        console.log("[VoiceTrace]", {
          event,
          connectionId: connection.id,
          elapsedMs: Date.now() - pipelineStart,
          ...details
        });
      };

      const flush = async (): Promise<boolean> => {
        if (!hasPendingSpeech) return false;
        await tts.flush();
        hasPendingSpeech = false;
        return true;
      };

      const speak = async (text: string): Promise<void> => {
        if (!text || signal.aborted) return;
        firstTextSentAt ??= Date.now();
        ttsStartedAt ??= Date.now();
        await tts.speak(text);
        spokenText += text;
        trace("tts_speak_sent", { chars: text.length, text });
        hasPendingSpeech = true;
      };

      const sendAssistantDelta = (text: string) => {
        if (!transcriptStarted) {
          this.#sendJSON(connection, {
            type: "transcript_start",
            role: "assistant"
          });
          transcriptStarted = true;
        }
        this.#sendJSON(connection, { type: "transcript_delta", text });
      };

      const flushOutput = async () => {
        if (!(await flush())) return;
        trace("tts_flush_complete");
        if (!signal.aborted) await this.#flushAudio(connection);
      };

      for await (const event of tokenStream) {
        if (signal.aborted) break;
        if (event.type === "boundary") {
          await flushOutput();
          continue;
        }
        if (event.type === "error") {
          await flushOutput();
          if (transcriptStarted) {
            this.#sendJSON(connection, {
              type: "transcript_end",
              text: fullText
            });
          }
          throw event.error;
        }

        const token = event.text;
        if (firstModelDeltaAt === null) trace("model_first_delta");
        firstModelDeltaAt ??= Date.now();
        fullText += token;
        sendAssistantDelta(token);
        await speak(token);
      }

      const llmMs = Date.now() - llmStart;
      if (!signal.aborted) await flushOutput();
      trace("model_stream_complete", {
        generatedChars: fullText.length,
        ttsChars: spokenText.length,
        aborted: signal.aborted,
        text: fullText.slice(0, 200)
      });
      if (transcriptStarted) {
        this.#sendJSON(connection, {
          type: "transcript_end",
          text: fullText
        });
      }
      trace("transcript_end_sent", { chars: fullText.length });

      const firstAudioAt = this.#firstRealtimeAudioAt.get(connection.id);
      return {
        text: spokenText,
        llmMs,
        ttsMs: ttsStartedAt ? Date.now() - ttsStartedAt : 0,
        firstModelDeltaMs: firstModelDeltaAt
          ? firstModelDeltaAt - pipelineStart
          : 0,
        firstSentenceMs: firstTextSentAt ? firstTextSentAt - pipelineStart : 0,
        firstAudioMs: firstAudioAt ? firstAudioAt - pipelineStart : 0
      };
    }

    async #streamingTTSPipeline(
      connection: Connection,
      tokenStream: AsyncIterable<TextStreamEvent>,
      llmStart: number,
      pipelineStart: number,
      signal: AbortSignal
    ): Promise<{
      text: string;
      llmMs: number;
      ttsMs: number;
      firstModelDeltaMs: number;
      firstSentenceMs: number;
      firstAudioMs: number;
    }> {
      const chunker = new SentenceChunker();
      const ttsQueue: AsyncIterable<ArrayBuffer>[] = [];
      let fullText = "";
      let pendingTranscriptText = "";
      let transcriptStarted = false;
      let firstAudioSentAt: number | null = null;
      let firstModelDeltaAt: number | null = null;
      let firstSentenceAt: number | null = null;
      let cumulativeTtsMs = 0;

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

      const tts = this.#requireTTS();

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
            for await (const chunk of ttsQueue[i]) {
              if (signal.aborted) return;
              await this.#sendAudio(connection, chunk);
              if (!firstAudioSentAt) {
                firstAudioSentAt = Date.now();
              }
            }
          } catch (err) {
            if (signal.aborted) return;
            console.error("[VoiceAgent] TTS error for sentence:", err);
            this.#sendJSON(connection, {
              type: "error",
              message:
                err instanceof Error ? err.message : "TTS failed for a sentence"
            });
          }
          i++;
          drainedCount = i;
          notifyDrained();
        }
      })();

      const makeSentenceTTS = (
        sentence: string
      ): AsyncIterable<ArrayBuffer> => {
        const self = this;
        async function* generate() {
          const ttsStart = Date.now();
          const text = await self.beforeSynthesize(sentence, connection);
          if (!text) return;

          const hasStreamingTTS = typeof tts.synthesizeStream === "function";
          if (hasStreamingTTS) {
            for await (const chunk of tts.synthesizeStream!(text, signal)) {
              const processed = await self.afterSynthesize(
                chunk,
                text,
                connection
              );
              if (processed) yield processed;
            }
          } else {
            const rawAudio = await tts.synthesize(text, signal);
            const processed = await self.afterSynthesize(
              rawAudio,
              text,
              connection
            );
            if (processed) yield processed;
          }
          cumulativeTtsMs += Date.now() - ttsStart;
        }

        return eagerAsyncIterable(generate());
      };

      const enqueueSentence = (sentence: string) => {
        firstSentenceAt ??= Date.now();
        ttsQueue.push(makeSentenceTTS(sentence));
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

        if (event.type === "boundary") {
          for (const sentence of chunker.flush()) {
            enqueueSentence(sentence);
          }
          await waitForDrained(ttsQueue.length);
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
          throw event.error;
        }

        const token = event.text;
        firstModelDeltaAt ??= Date.now();

        fullText += token;
        sendAssistantDelta(token);

        const sentences = chunker.add(token);
        for (const sentence of sentences) {
          enqueueSentence(sentence);
        }
      }

      const llmMs = Date.now() - llmStart;

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
        firstAudioMs
      };
    }

    // --- Internal: protocol helpers ---

    #sendJSON(connection: Connection, data: unknown) {
      const parsed = data as Record<string, unknown>;
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

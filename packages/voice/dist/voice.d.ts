import {
  _ as VoiceTransport,
  a as TranscriberSession,
  c as VOICE_PROTOCOL_VERSION,
  d as VoiceClientMessage,
  f as VoicePipelineMetrics,
  g as VoiceStatus,
  h as VoiceServerMessage,
  i as Transcriber,
  l as VoiceAudioFormat,
  m as VoiceServerAudioTransport,
  n as StreamingTextTTSProvider,
  o as TranscriberSessionOptions,
  p as VoiceRole,
  r as TTSProvider,
  s as TranscriptMessage,
  t as StreamingTTSProvider,
  u as VoiceAudioInput
} from "./types-l9Ypungv.js";
import { RpcTarget } from "cloudflare:workers";
import { Agent, Connection } from "agents";

//#region src/sentence-chunker.d.ts
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
declare class SentenceChunker {
  #private;
  private readonly maxChunkLength;
  /**
   * @param maxChunkLength Maximum phrase length. Omit to split only sentences.
   */
  constructor(maxChunkLength?: number);
  /**
   * Add a chunk of text (e.g. a streamed LLM token).
   * Returns an array of complete sentences extracted from the buffer.
   * May return 0, 1, or multiple sentences depending on the input.
   */
  add(text: string): string[];
  /**
   * Flush any remaining text in the buffer as a final sentence.
   * Call this when the LLM stream ends.
   * Returns the remaining text (trimmed), or an empty array if nothing is left.
   */
  flush(): string[];
  /**
   * Reset the chunker, discarding any buffered text.
   */
  reset(): void;
}
//#endregion
//#region src/voice-input.d.ts
type Constructor$3<T = object> = new (...args: any[]) => T;
type AgentLike$3 = Constructor$3<Pick<Agent<Cloudflare.Env>, "keepAlive">>;
/** Public surface of the voice input mixin, used as an explicit return type to satisfy TS6 declaration emit. */
interface VoiceInputMixinMembers {
  transcriber?: Transcriber;
  onTranscript(text: string, connection: Connection): void | Promise<void>;
  createTranscriber(connection: Connection): Transcriber | null;
  beforeCallStart(connection: Connection): boolean | Promise<boolean>;
  onCallStart(connection: Connection): void | Promise<void>;
  onCallEnd(connection: Connection): void | Promise<void>;
  onInterrupt(connection: Connection): void | Promise<void>;
  afterTranscribe(
    transcript: string,
    connection: Connection
  ): string | null | Promise<string | null>;
}
type VoiceInputMixinReturn<TBase extends AgentLike$3> = TBase &
  (new (...args: any[]) => VoiceInputMixinMembers);
/**
 * Voice-to-text input mixin. Adds STT-only voice input to an Agent class.
 *
 * Subclasses must set a `transcriber` property (or override `createTranscriber`).
 * No TTS provider is needed. Override `onTranscript` to handle each
 * transcribed utterance.
 *
 * @param Base - The Agent class to extend (e.g. `Agent`).
 * @param voiceInputOptions - Optional pipeline configuration.
 *
 * @example
 * ```typescript
 * import { Agent } from "agents";
 * import { withVoiceInput, WorkersAINova3STT } from "@cloudflare/voice";
 *
 * const InputAgent = withVoiceInput(Agent);
 *
 * class MyAgent extends InputAgent<Env> {
 *   transcriber = new WorkersAINova3STT(this.env.AI);
 *
 *   onTranscript(text, connection) {
 *     console.log("User said:", text);
 *   }
 * }
 * ```
 */
declare function withVoiceInput<TBase extends AgentLike$3>(
  Base: TBase
): VoiceInputMixinReturn<TBase>;
//#endregion
//#region src/text-stream.d.ts
/**
 * Utilities for normalising various text-producing sources into a uniform
 * `AsyncGenerator<string>`.  This lets `onTurn()` return any of:
 *
 *   - A plain `string`
 *   - An `AsyncIterable<string>` (deprecated for AI SDK `textStream`)
 *   - An `AsyncIterable` of AI SDK `stream` parts
 *   - A `ReadableStream<Uint8Array>` (e.g. a raw `fetch` response body
 *     containing newline-delimited JSON / SSE)
 *   - A `ReadableStream<string>`
 *
 * The generator yields individual text chunks as they become available.
 */
/** Union of every source type that {@link iterateText} accepts. */
type TextSource = string | TextReadableStream | AsyncIterable<unknown>;
type TextReadableStreamReader = {
  read(): Promise<ReadableStreamReadResult<unknown>>;
};
interface TextReadableStream {
  getReader(): TextReadableStreamReader;
}
/**
 * Turn any {@link TextSource} into a lazy async generator of string chunks.
 *
 * - `string` → yields the string once (if non-empty).
 * - `ReadableStream<string>` → yields each chunk directly.
 * - `ReadableStream<Uint8Array>` → decodes and parses as newline-delimited
 *   JSON (NDJSON) / SSE (`data: …` lines), extracting text from common AI
 *   response formats.
 * - `AsyncIterable<string>` → re-yields each chunk.
 */
declare function iterateText(source: TextSource): AsyncGenerator<string>;
//#endregion
//#region src/rpc-voice.d.ts
interface VoiceRpcCallbackOptions {
  /** Called when the remote turn exposes its cancellation request id. */
  onRequestId?: (requestId: string) => void;
}
/**
 * RPC callback for streaming text from any remote agent into Voice.
 *
 * Targets that emit JSON-serialized AI SDK stream events can call `onEvent()`.
 * Other targets can call `onText()` directly.
 */
declare class VoiceRpcCallback extends RpcTarget {
  #private;
  constructor(options?: VoiceRpcCallbackOptions);
  onStart(event: { requestId: string }): void;
  /** Stream a plain text delta from a custom RPC target. */
  onText(text: string): void;
  /** Consume a JSON-serialized AI SDK stream event. */
  onEvent(json: string): void;
  onDone(): void;
  onError(error: string): void;
  onInterrupted(): void;
  requestId(): string | undefined;
  hasText(): boolean;
  wasInterrupted(): boolean;
  close(): void;
  fail(error: unknown): void;
  stream(): AsyncIterable<string>;
}
interface RpcVoiceTurnOptions {
  /** The Voice turn abort signal. */
  signal: AbortSignal;
  /** Start the remote turn and keep this promise pending until it completes. */
  run: (callback: VoiceRpcCallback) => Promise<void>;
  /** Cancel the remote turn after `onStart()` exposes its request id. */
  cancel?: (requestId: string, reason: string) => Promise<void> | void;
  /** Observe the remote request id, for logging or correlation. */
  onRequestId?: (requestId: string) => void;
  /** Spoken only when the completed remote turn produced no visible text. */
  emptyResponse?: string;
  /** Cancellation reason passed to the remote target. */
  interruptionReason?: string;
}
/**
 * Start an RPC-backed agent turn and return its text stream to `withVoice()`.
 *
 * The callback is a Workers `RpcTarget`, so the remote target can stream into
 * it while `run()` remains pending. Aborting the Voice turn closes the local
 * stream immediately and, once available, forwards the request id to
 * `cancel()`.
 */
declare function streamRpcVoiceTurn(
  options: RpcVoiceTurnOptions
): AsyncIterable<string>;
//#endregion
//#region src/sfu-utils.d.ts
/**
 * Pure utility functions for the Cloudflare Realtime SFU integration.
 *
 * Extracted from sfu.ts for testability. These handle:
 * - Protobuf varint encoding/decoding
 * - SFU WebSocket adapter protobuf packet encoding/decoding
 * - Audio format conversion (48kHz stereo ↔ 16kHz mono)
 */
declare function decodeVarint(
  buf: Uint8Array,
  offset: number
): {
  value: number;
  bytesRead: number;
};
declare function encodeVarint(value: number): Uint8Array;
/** Extract the PCM payload from a protobuf Packet message. */
declare function extractPayloadFromProtobuf(
  data: ArrayBuffer
): Uint8Array | null;
/** Encode PCM payload into a protobuf Packet message (for ingest/buffer mode — just payload). */
declare function encodePayloadToProtobuf(payload: Uint8Array): ArrayBuffer;
/** Convert mono PCM16 at an arbitrary sample rate to 48kHz stereo PCM16. */
declare function resampleMonoTo48kStereo(
  input: ArrayBuffer,
  inputSampleRate: number
): Uint8Array;
/** Downsample 48kHz stereo interleaved PCM to 16kHz mono PCM (both 16-bit LE). */
declare function downsample48kStereoTo16kMono(
  stereo48k: Uint8Array
): ArrayBuffer;
/** Upsample 16kHz mono PCM to 48kHz stereo interleaved PCM (both 16-bit LE). */
declare function upsample16kMonoTo48kStereo(mono16k: ArrayBuffer): Uint8Array;
/** Resample 24kHz mono PCM to 48kHz stereo interleaved PCM (both 16-bit LE). */
declare function resample24kMonoTo48kStereo(mono24k: ArrayBuffer): Uint8Array;
interface SFUConfig {
  appId: string;
  apiToken: string;
  apiBase?: string;
}
declare function sfuFetch(
  config: SFUConfig,
  path: string,
  body: unknown
): Promise<unknown>;
declare function createSFUSession(config: SFUConfig): Promise<{
  sessionId: string;
}>;
declare function addSFUTracks(
  config: SFUConfig,
  sessionId: string,
  body: unknown
): Promise<unknown>;
declare function renegotiateSFUSession(
  config: SFUConfig,
  sessionId: string,
  sessionDescription: {
    type?: string;
    sdp: string;
  }
): Promise<unknown>;
declare function createSFUWebSocketAdapter(
  config: SFUConfig,
  tracks: unknown[]
): Promise<unknown>;
declare function closeSFUWebSocketAdapter(
  config: SFUConfig,
  adapterId: string
): Promise<{
  alreadyClosed: boolean;
}>;
//#endregion
//#region src/sfu-transport.d.ts
interface SFUVoiceState {
  tts?: {
    sessionId: string;
    adapterId: string;
    trackName: string;
  };
  stt?: {
    sessionId: string;
    trackName: string;
    callbackUrl: string;
    adapterId?: string;
  };
}
interface SFUVoiceTransportOptions {
  config: SFUConfig;
  routePrefix?: string;
  inputSampleRate?: number;
  loadState?: () => Promise<SFUVoiceState | null>;
  saveState?: (state: SFUVoiceState | null) => Promise<void>;
}
declare class SFUVoiceTransport implements VoiceServerAudioTransport {
  #private;
  constructor(options: SFUVoiceTransportOptions);
  start(
    connectionId: string,
    onAudio: (audio: ArrayBuffer) => void
  ): Promise<void>;
  send(connectionId: string, audio: ArrayBuffer): void;
  flush(connectionId: string): Promise<void>;
  interrupt(connectionId: string): void;
  stop(connectionId: string): Promise<void>;
  handleWebSocketUpgrade(request: Request): Response | null;
  handleHttpRequest(request: Request): Promise<Response | null>;
}
//#endregion
//#region src/sfu-voice.d.ts
type SFUVoiceAgentOptions = Omit<VoiceAgentOptions, "audioFormat"> & {
  routePrefix?: string;
};
type Constructor$2<T = object> = new (...args: any[]) => T;
type AgentLike$2 = Constructor$2<Agent>;
interface SFUVoiceAgentMixinMembers extends VoiceAgentMixinMembers {
  getSFUConfig(): SFUConfig;
}
type SFUVoiceAgentMixinReturn<TBase extends AgentLike$2> = TBase &
  (new (...args: any[]) => SFUVoiceAgentMixinMembers);
declare function withSFUVoice<TBase extends AgentLike$2>(
  Base: TBase,
  options?: SFUVoiceAgentOptions
): SFUVoiceAgentMixinReturn<TBase>;
//#endregion
//#region src/voice-agent-factory.d.ts
type Constructor$1<T = object> = new (...args: any[]) => T;
type AgentLike$1 = Constructor$1<Agent<Cloudflare.Env>>;
interface VoiceAgentFactoryConfig extends VoiceAgentOptions {
  /** Constructs the transcriber for this agent instance. Called once from a field initializer, after `this.env` is available. */
  stt: (env: Cloudflare.Env) => Transcriber;
  /** Constructs the TTS provider for this agent instance. Same lifecycle as `stt`. */
  tts: (env: Cloudflare.Env) => TTSProvider & Partial<StreamingTTSProvider>;
  /** Greeting spoken by the default `onCallStart()`. Omit to skip — a subclass may still override `onCallStart()` itself. */
  greeting?: string;
}
interface VoiceAgentFactoryMixinMembers extends VoiceAgentMixinMembers {
  /**
   * Per-call config resolved by the transport adapter and delivered via
   * `getAgentByName(namespace, name, { props })` (see
   * `SignalWireAdapterOptions.resolveProps`). Populated in `onStart()`.
   * A subclass that overrides `onStart()` must call `super.onStart(props)`
   * to keep this in sync.
   */
  callProps?: Record<string, unknown>;
  onStart(props?: Record<string, unknown>): void | Promise<void>;
}
type VoiceAgentFactoryReturn<TBase extends AgentLike$1> = TBase &
  (new (...args: any[]) => VoiceAgentFactoryMixinMembers);
/**
 * Config-driven voice agent mixin. Composes `withVoice()` — same pipeline,
 * same protocol — with STT/TTS provider construction, a default greeting,
 * and per-call props handling collapsed into a config object. `onTurn()`
 * is still a required subclass override (the library has no LLM/model
 * dependency); everything else about `withVoice()`-based agents (further
 * subclassing, lifecycle hook overrides) still applies.
 *
 * Usage:
 *   const VoiceAgent = createVoiceAgent(Agent, {
 *     stt: (env: Env) => new WorkersAIFluxSTT(env.AI, { eotThreshold: 0.7 }),
 *     tts: (env: Env) => new WorkersAIRealtimeTTS(env.AI),
 *     greeting: "Hello! How can I help you today?"
 *   });
 *
 *   class MyAgent extends VoiceAgent<Env> {
 *     async onTurn(transcript, context) { ... this.callProps ... }
 *   }
 *
 * @experimental This API is not yet stable and may change.
 */
declare function createVoiceAgent<TBase extends AgentLike$1>(
  Base: TBase,
  config: VoiceAgentFactoryConfig
): VoiceAgentFactoryReturn<TBase>;
//#endregion
//#region src/workers-ai-providers.d.ts
/** Loose type for the Workers AI binding — avoids hard dependency on @cloudflare/workers-types. */
interface AiLike {
  fetch?(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  run(
    model: string,
    input: Record<string, unknown>,
    options?: Record<string, unknown>
  ): Promise<unknown>;
}
interface WorkersAITTSOptions {
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
declare class WorkersAITTS implements TTSProvider {
  #private;
  constructor(ai: AiLike, options?: WorkersAITTSOptions);
  synthesize(text: string, signal?: AbortSignal): Promise<ArrayBuffer | null>;
}
type WorkersAIRealtimeTTSOptions = {
  /** TTS model name. @default "@cf/deepgram/aura-2-en" */ model?: string /** TTS speaker voice. @default "asteria" */;
  speaker?: string;
} & (
  | {
      encoding?: "mulaw";
      sampleRate?: 8000;
    }
  | {
      encoding: "linear16";
      sampleRate?: 24000;
    }
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
declare class WorkersAIRealtimeTTS
  extends WorkersAITTS
  implements StreamingTTSProvider
{
  #private;
  readonly audioFormat: VoiceAudioFormat;
  readonly sampleRate: number;
  constructor(ai: AiLike, options?: WorkersAIRealtimeTTSOptions);
  synthesizeStream(
    text: string,
    signal?: AbortSignal
  ): AsyncGenerator<ArrayBuffer>;
}
interface WorkersAIGrokTTSOptions {
  /** Grok voice. @default "ara" */
  voice?: string;
  /** BCP-47 language code. @default "en" */
  language?: string;
  /**
   * xAI streaming latency optimization. `1` lowers first-audio latency with a
   * minor quality tradeoff. @default 1
   */
  optimizeStreamingLatency?: 0 | 1 | 2;
}
/**
 * Streaming xAI Grok TTS through the Workers AI binding.
 *
 * Grok's MP3 WebSocket output is decoded to PCM16 as each chunk arrives, so
 * callers do not need an xAI API key or a complete audio download.
 */
declare class WorkersAIGrokTTS
  implements TTSProvider, StreamingTTSProvider, StreamingTextTTSProvider
{
  #private;
  readonly audioFormat: VoiceAudioFormat;
  readonly sampleRate = 24000;
  constructor(ai: AiLike, options?: WorkersAIGrokTTSOptions);
  synthesize(text: string, signal?: AbortSignal): Promise<ArrayBuffer | null>;
  synthesizeStream(
    text: string,
    signal?: AbortSignal
  ): AsyncGenerator<ArrayBuffer>;
  synthesizeTextStream(
    text: ReadableStream<string>,
    signal?: AbortSignal
  ): AsyncGenerator<ArrayBuffer>;
}
interface WorkersAIFluxSTTOptions {
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
declare class WorkersAIFluxSTT implements Transcriber {
  #private;
  constructor(ai: AiLike, options?: WorkersAIFluxSTTOptions);
  createSession(options?: TranscriberSessionOptions): TranscriberSession;
}
interface WorkersAINova3STTOptions {
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
declare class WorkersAINova3STT implements Transcriber {
  #private;
  constructor(ai: AiLike, options?: WorkersAINova3STTOptions);
  createSession(options?: TranscriberSessionOptions): TranscriberSession;
}
//#endregion
//#region src/voice.d.ts
/** Context passed to the `onTurn()` hook. */
interface VoiceTurnContext {
  connection: Connection;
  /** Completed conversation history before the current transcript. */
  messages: Array<{
    role: VoiceRole;
    content: string;
  }>;
  signal: AbortSignal;
}
/** Configuration options for the voice mixin. Passed to `withVoice()`. */
interface VoiceAgentOptions {
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
   * Durable Object instance. @default false
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
}
type Constructor<T = object> = new (...args: any[]) => T;
type AgentLike = Constructor<Agent<Cloudflare.Env>>;
/** Public surface of the voice mixin, used as an explicit return type to satisfy TS6 declaration emit. */
interface VoiceAgentMixinMembers {
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
  getConversationHistory(limit?: number): Array<{
    role: VoiceRole;
    content: string;
  }>;
  forceEndCall(connection: Connection): void;
  speak(connection: Connection, text: string): Promise<void>;
  speakAll(text: string): Promise<void>;
}
type VoiceAgentMixinReturn<TBase extends AgentLike> = TBase &
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
declare function withVoice<TBase extends AgentLike>(
  Base: TBase,
  voiceOptions?: VoiceAgentOptions
): VoiceAgentMixinReturn<TBase>;
//#endregion
export {
  type RpcVoiceTurnOptions,
  type SFUConfig,
  type SFUVoiceAgentOptions,
  type SFUVoiceState,
  SFUVoiceTransport,
  type SFUVoiceTransportOptions,
  SentenceChunker,
  type StreamingTTSProvider,
  type StreamingTextTTSProvider,
  type TTSProvider,
  type TextSource,
  type Transcriber,
  type TranscriberSession,
  type TranscriberSessionOptions,
  type TranscriptMessage,
  VOICE_PROTOCOL_VERSION,
  type VoiceAgentFactoryConfig,
  type VoiceAgentFactoryMixinMembers,
  VoiceAgentMixinMembers,
  VoiceAgentOptions,
  type VoiceAudioFormat,
  type VoiceAudioInput,
  type VoiceClientMessage,
  type VoicePipelineMetrics,
  type VoiceRole,
  VoiceRpcCallback,
  type VoiceRpcCallbackOptions,
  type VoiceServerAudioTransport,
  type VoiceServerMessage,
  type VoiceStatus,
  type VoiceTransport,
  VoiceTurnContext,
  WorkersAIFluxSTT,
  type WorkersAIFluxSTTOptions,
  WorkersAIGrokTTS,
  type WorkersAIGrokTTSOptions,
  WorkersAINova3STT,
  type WorkersAINova3STTOptions,
  WorkersAIRealtimeTTS,
  type WorkersAIRealtimeTTSOptions,
  WorkersAITTS,
  type WorkersAITTSOptions,
  addSFUTracks,
  closeSFUWebSocketAdapter,
  createSFUSession,
  createSFUWebSocketAdapter,
  createVoiceAgent,
  decodeVarint,
  downsample48kStereoTo16kMono,
  encodePayloadToProtobuf,
  encodeVarint,
  extractPayloadFromProtobuf,
  iterateText,
  renegotiateSFUSession,
  resample24kMonoTo48kStereo,
  resampleMonoTo48kStereo,
  sfuFetch,
  streamRpcVoiceTurn,
  upsample16kMonoTo48kStereo,
  withSFUVoice,
  withVoice,
  withVoiceInput
};
//# sourceMappingURL=voice.d.ts.map

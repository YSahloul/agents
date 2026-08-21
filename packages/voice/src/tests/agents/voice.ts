import { Agent, type Connection, type WSMessage } from "agents";
import {
  isStepCount,
  streamText,
  tool,
  type LanguageModel,
  type ToolSet
} from "ai";
import { z } from "zod";
import { withVoice, type TextSource, type VoiceTurnContext } from "../../voice";
import type {
  TTSProvider,
  StreamingTTSProvider,
  StreamingTextTTSProvider,
  Transcriber,
  TranscriberSession,
  TranscriberSessionOptions,
  VoiceServerAudioTransport,
  VoiceCallStartContext
} from "../../types";

/** Deterministic TTS provider for tests — encodes text as bytes. */
class TestTTS implements TTSProvider {
  async synthesize(text: string): Promise<ArrayBuffer | null> {
    const buffer = new ArrayBuffer(text.length);
    const view = new Uint8Array(buffer);
    for (let i = 0; i < text.length; i++) {
      view[i] = text.charCodeAt(i) & 0xff;
    }
    return buffer;
  }
}

/** Bidirectional TTS provider that turns each model text delta into audio. */
class TestStreamingTTS implements TTSProvider, StreamingTextTTSProvider {
  chunks: string[] = [];

  async synthesize(text: string): Promise<ArrayBuffer | null> {
    return new TextEncoder().encode(text).buffer;
  }

  async *synthesizeTextStream(
    text: ReadableStream<string>
  ): AsyncGenerator<ArrayBuffer> {
    const reader = text.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        this.chunks.push(value);
        yield new TextEncoder().encode(value).buffer;
      }
    } finally {
      reader.releaseLock();
    }
  }
}
class ControlledTestStreamingTTS
  extends TestTTS
  implements StreamingTTSProvider
{
  #getSignal: () => AbortSignal | null;
  #releaseCurrent: (() => void) | null = null;

  constructor(getSignal: () => AbortSignal | null) {
    super();
    this.#getSignal = getSignal;
  }

  release(): void {
    this.#releaseCurrent?.();
  }

  async *synthesizeStream(text: string): AsyncGenerator<ArrayBuffer> {
    const mid = Math.max(1, Math.ceil(text.length / 2));
    yield new TextEncoder().encode(text.slice(0, mid)).buffer;

    const signal = this.#getSignal();
    if (signal?.aborted) return;
    const { promise, resolve } = Promise.withResolvers<void>();
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (this.#releaseCurrent === finish) this.#releaseCurrent = null;
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    this.#releaseCurrent = finish;
    signal?.addEventListener("abort", finish, { once: true });
    await promise;

    if (signal?.aborted) return;
    const remainder = text.slice(mid);
    if (remainder) {
      yield new TextEncoder().encode(remainder).buffer;
    }
  }
}

class TestAudioTransport implements VoiceServerAudioTransport {
  events: string[] = [];
  #onAudio: ((audio: ArrayBuffer) => void) | null = null;

  start(connectionId: string, onAudio: (audio: ArrayBuffer) => void): void {
    this.events.push(`start:${connectionId}`);
    this.#onAudio = onAudio;
  }

  send(_connectionId: string, audio: ArrayBuffer): void {
    this.events.push(`send:${audio.byteLength}`);
  }

  flush(_connectionId: string): void {
    this.events.push("flush");
  }

  interrupt(_connectionId: string): void {
    this.events.push("interrupt");
  }

  stop(_connectionId: string): void {
    this.events.push("stop");
    this.#onAudio = null;
  }

  emit(byteLength: number): void {
    this.#onAudio?.(new ArrayBuffer(byteLength));
  }
}

/**
 * Deterministic continuous transcriber session for tests.
 * Fires onUtterance every `utteranceThreshold` bytes accumulated.
 */
class TestTranscriberSession implements TranscriberSession {
  #totalBytes = 0;
  #utteranceCount = 0;
  #closed = false;
  #onInterim: ((text: string) => void) | undefined;
  #onSpeechStart: ((text?: string) => void) | undefined;
  #onUtterance: ((text: string) => void) | undefined;
  #onEagerUtterance: ((text: string) => void) | undefined;
  #onTurnResumed: ((text?: string) => void) | undefined;
  #utteranceThreshold: number;

  // Test introspection: agent_context values delivered mid-session.
  agentContexts: string[] = [];

  constructor(options?: TranscriberSessionOptions, utteranceThreshold = 20000) {
    this.#onInterim = options?.onInterim;
    this.#onSpeechStart = options?.onSpeechStart;
    this.#onUtterance = options?.onUtterance;
    this.#onEagerUtterance = options?.onEagerUtterance;
    this.#onTurnResumed = options?.onTurnResumed;
    this.#utteranceThreshold = utteranceThreshold;
  }

  feed(chunk: ArrayBuffer): void {
    if (this.#closed) return;
    this.#totalBytes += chunk.byteLength;
    this.#onSpeechStart?.(`hearing ${this.#totalBytes} bytes`);
    this.#onInterim?.(`hearing ${this.#totalBytes} bytes`);

    const nextThreshold = (this.#utteranceCount + 1) * this.#utteranceThreshold;
    if (this.#totalBytes >= nextThreshold) {
      this.#utteranceCount++;
      const transcript = `utterance ${this.#utteranceCount} (${this.#totalBytes} bytes)`;
      this.#onUtterance?.(transcript);
    }
  }

  updateAgentContext(text: string): void {
    if (this.#closed) return;
    this.agentContexts.push(text);
  }

  emitSpeechStart(transcript?: string): void {
    if (!this.#closed) this.#onSpeechStart?.(transcript);
  }
  emitEnd(transcript: string): void {
    if (!this.#closed) this.#onUtterance?.(transcript);
  }
  emitEager(transcript: string): void {
    if (!this.#closed) this.#onEagerUtterance?.(transcript);
  }
  emitTurnResumed(transcript?: string): void {
    if (!this.#closed) this.#onTurnResumed?.(transcript);
  }
  close(): void {
    this.#closed = true;
  }
}

class TestTranscriber implements Transcriber {
  #utteranceThreshold: number;

  // Test introspection: the most recently created session.
  lastSession: TestTranscriberSession | null = null;

  constructor(utteranceThreshold = 20000) {
    this.#utteranceThreshold = utteranceThreshold;
  }

  createSession(options?: TranscriberSessionOptions): TranscriberSession {
    this.lastSession = new TestTranscriberSession(
      options,
      this.#utteranceThreshold
    );
    return this.lastSession;
  }
}

type TestTranscriberMode =
  | "default"
  | "missing"
  | "pending_ready"
  | "pending_ready_no_close_settle"
  | "reject_ready"
  | "create_throw";

function isTestTranscriberMode(value: unknown): value is TestTranscriberMode {
  return (
    value === "default" ||
    value === "missing" ||
    value === "pending_ready" ||
    value === "pending_ready_no_close_settle" ||
    value === "reject_ready" ||
    value === "create_throw"
  );
}

class ControlledReadyTranscriberSession extends TestTranscriberSession {
  #ready: Promise<void>;
  #resolveReady: (() => void) | null = null;
  #rejectReady: ((reason: unknown) => void) | null = null;
  #settleOnClose: boolean;

  constructor(options?: TranscriberSessionOptions, settleOnClose = true) {
    super(options);
    this.#settleOnClose = settleOnClose;
    this.#ready = new Promise<void>((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
    this.#ready.catch(() => {});
  }

  waitUntilReady(): Promise<void> {
    return this.#ready;
  }

  resolveReady(): void {
    const resolve = this.#resolveReady;
    if (!resolve) return;
    this.#resolveReady = null;
    this.#rejectReady = null;
    resolve();
  }

  rejectReady(message = "readiness failed"): void {
    const reject = this.#rejectReady;
    if (!reject) return;
    this.#resolveReady = null;
    this.#rejectReady = null;
    reject(new Error(message));
  }

  close(): void {
    super.close();
    if (this.#settleOnClose) this.resolveReady();
  }
}

const v3FinishReason = (unified: "stop" | "tool-calls") => ({
  unified,
  raw: undefined
});

const v3Usage = (inputTokens: number, outputTokens: number) => ({
  inputTokens: {
    total: inputTokens,
    noCache: inputTokens,
    cacheRead: 0,
    cacheWrite: 0
  },
  outputTokens: { total: outputTokens, text: outputTokens, reasoning: 0 }
});

type MockTextStreamPart =
  | { type: "text"; text: string }
  | { type: "error"; message: string }
  | {
      type: "tool-call";
      toolName: string;
      input: Record<string, unknown>;
      output?: unknown;
      outputDelayMs?: number;
      toolCallId?: string;
    };

type MockTextStreamResponse = MockTextStreamPart[][];

const defaultMockTextStreamResponse: MockTextStreamResponse = [
  [
    { type: "text", text: "I can get the weather for you." },
    {
      type: "tool-call",
      toolName: "getWeather",
      input: { location: "San Francisco" },
      output: "warm"
    }
  ],
  [{ type: "text", text: "The weather is warm" }]
];

function createToolCallingTextStreamModel(
  response: MockTextStreamResponse
): LanguageModel {
  let callCount = 0;

  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "mock-tool-text-stream",
    supportedUrls: {},
    doGenerate() {
      throw new Error("doGenerate not implemented");
    },
    doStream(_options: Record<string, unknown>) {
      callCount++;
      const step = response[callCount - 1] ?? [];
      const hasToolCall = step.some((part) => part.type === "tool-call");

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });

          for (let i = 0; i < step.length; i++) {
            const part = step[i];
            if (part.type === "text") {
              const id = `t-${callCount}-${i}`;
              controller.enqueue({ type: "text-start", id });
              controller.enqueue({
                type: "text-delta",
                id,
                delta: part.text
              });
              controller.enqueue({ type: "text-end", id });
            } else if (part.type === "error") {
              controller.enqueue({
                type: "error",
                error: new Error(part.message)
              });
            } else {
              const id = part.toolCallId ?? `tc-${callCount}-${i}`;
              controller.enqueue({
                type: "tool-input-start",
                id,
                toolName: part.toolName
              });
              controller.enqueue({
                type: "tool-input-delta",
                id,
                delta: JSON.stringify(part.input)
              });
              controller.enqueue({ type: "tool-input-end", id });
              controller.enqueue({
                type: "tool-call",
                toolCallId: id,
                toolName: part.toolName,
                input: JSON.stringify(part.input)
              });
            }
          }

          controller.enqueue({
            type: "finish",
            finishReason: v3FinishReason(hasToolCall ? "tool-calls" : "stop"),
            usage: v3Usage(10 * callCount, 5 * callCount)
          });

          controller.close();
        }
      });

      return Promise.resolve({ stream });
    }
  } as LanguageModel;
}

function createMockTools(response: MockTextStreamResponse): ToolSet {
  const toolOutputs = new Map<
    string,
    { output: unknown; outputDelayMs?: number }[]
  >();
  for (const step of response) {
    for (const part of step) {
      if (part.type === "tool-call") {
        const outputs = toolOutputs.get(part.toolName) ?? [];
        outputs.push({
          output: part.output ?? `${part.toolName} result`,
          ...(part.outputDelayMs === undefined
            ? {}
            : { outputDelayMs: part.outputDelayMs })
        });
        toolOutputs.set(part.toolName, outputs);
      }
    }
  }

  const tools: ToolSet = {};
  for (const [toolName, outputs] of toolOutputs) {
    tools[toolName] = tool({
      description: `Mock ${toolName} tool`,
      inputSchema: z.record(z.string(), z.unknown()),
      execute: async (_input: Record<string, unknown>) => {
        const result = outputs.shift();
        if (!result) return `${toolName} result`;
        if (result.outputDelayMs) {
          await new Promise((resolve) =>
            setTimeout(resolve, result.outputDelayMs)
          );
        }
        return result.output;
      }
    });
  }

  return tools;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMockTextStreamResponse(
  value: unknown
): value is MockTextStreamResponse {
  return (
    Array.isArray(value) &&
    value.every(
      (step) =>
        Array.isArray(step) &&
        step.every((part) => {
          if (!isRecord(part)) return false;
          if (part.type === "text") return typeof part.text === "string";
          if (part.type === "error") return typeof part.message === "string";
          return (
            part.type === "tool-call" &&
            typeof part.toolName === "string" &&
            isRecord(part.input) &&
            (part.output === undefined || isJsonValue(part.output)) &&
            (part.outputDelayMs === undefined ||
              typeof part.outputDelayMs === "number") &&
            (part.toolCallId === undefined ||
              typeof part.toolCallId === "string")
          );
        })
    )
  );
}

function isJsonValue(value: unknown): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (isRecord(value)) return Object.values(value).every(isJsonValue);
  return false;
}

// --- Test agents ---

const VoiceBase = withVoice(Agent);
const Pcm24kVoiceBase = withVoice(Agent, {
  audioFormat: "pcm16",
  sampleRate: 24000
});
const PersistentVoiceBase = withVoice(Agent, { persistMessages: true });
const MinInterruptVoiceBase = withVoice(Agent, {
  minInterruptWords: 3
});

/**
 * Test VoiceAgent with continuous transcriber.
 * Echoes back the transcript (no real AI).
 */
type TestTurnMode = "normal" | "reject" | "until_abort";

export class TestVoiceAgent extends VoiceBase {
  static options = { hibernate: false };

  transcriber: Transcriber | undefined = new TestTranscriber();
  tts: TTSProvider & Partial<StreamingTTSProvider> = new TestTTS();

  #callStartCount = 0;
  #callEndCount = 0;
  #interruptCount = 0;
  #callStartResumed: boolean[] = [];
  #beforeCallStartResult: boolean | "throw" = true;
  #keepAliveShouldThrow = false;
  #turnDelayMs = 0;
  #transcriberMode: TestTranscriberMode = "default";
  #lastReadySession: ControlledReadyTranscriberSession | null = null;
  #readySessions: ControlledReadyTranscriberSession[] = [];
  #keepAliveAcquiredCount = 0;
  #callStartGate: { promise: Promise<void>; resolve: () => void } | null = null;
  #keepAliveReleasedCount = 0;
  #useAudioTransport = false;
  #audioTransport = new TestAudioTransport();
  #streamTurns = false;
  #turnMode: TestTurnMode = "normal";
  #turnTranscripts: string[] = [];
  #turnAbortCount = 0;
  #currentTurnSignal: AbortSignal | null = null;
  #controlledTTS = new ControlledTestStreamingTTS(
    () => this.#currentTurnSignal
  );

  async keepAlive(): Promise<() => void> {
    if (this.#keepAliveShouldThrow) {
      throw new Error("keepAlive failed");
    }

    this.#keepAliveAcquiredCount++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#keepAliveReleasedCount++;
    };
  }

  createAudioTransport(
    _connection: Connection
  ): VoiceServerAudioTransport | null {
    return this.#useAudioTransport ? this.#audioTransport : null;
  }

  createTranscriber(_connection: Connection): Transcriber | null {
    const mode = this.#transcriberMode;
    if (mode === "default") return null;
    if (mode === "missing") return null;
    if (mode === "create_throw") {
      return {
        createSession(): TranscriberSession {
          throw new Error("create session failed");
        }
      };
    }

    return {
      createSession: (options?: TranscriberSessionOptions) => {
        const session = new ControlledReadyTranscriberSession(
          options,
          mode !== "pending_ready_no_close_settle"
        );
        this.#lastReadySession = session;
        this.#readySessions.push(session);
        if (mode === "reject_ready") {
          session.rejectReady();
        }
        return session;
      }
    };
  }

  async onTurn(
    transcript: string,
    context: VoiceTurnContext
  ): Promise<TextSource> {
    this.#turnTranscripts.push(transcript);
    this.#currentTurnSignal = context.signal;
    if (context.signal.aborted) {
      this.#turnAbortCount++;
    } else {
      context.signal.addEventListener(
        "abort",
        () => {
          this.#turnAbortCount++;
        },
        { once: true }
      );
    }

    if (this.#turnMode === "reject") {
      throw new Error("test turn failure");
    }
    if (this.#turnMode === "until_abort") {
      const { promise, resolve } = Promise.withResolvers<void>();
      if (context.signal.aborted) {
        resolve();
      } else {
        context.signal.addEventListener("abort", () => resolve(), {
          once: true
        });
      }
      await promise;
    }
    if (this.#turnDelayMs > 0) {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, this.#turnDelayMs);
      await promise;
    }
    if (!this.#streamTurns) return `Echo: ${transcript}`;
    return (async function* () {
      yield "Echo:";
      yield ` ${transcript}`;
    })();
  }

  beforeCallStart(_connection: Connection): boolean {
    if (this.#beforeCallStartResult === "throw") {
      throw new Error("beforeCallStart failed");
    }

    return this.#beforeCallStartResult;
  }

  async onCallStart(
    _connection: Connection,
    { resumed }: VoiceCallStartContext
  ) {
    this.#callStartCount++;
    this.#callStartResumed.push(resumed);
    await this.#callStartGate?.promise;
  }

  onCallEnd(_connection: Connection) {
    this.#callEndCount++;
  }

  onInterrupt(_connection: Connection) {
    this.#interruptCount++;
  }

  onClose(_connection: Connection): void {}

  onMessage(connection: Connection, message: WSMessage) {
    if (typeof message !== "string") return;
    try {
      const parsed = JSON.parse(message);
      switch (parsed.type) {
        case "_set_before_call_start":
          if (parsed.value === true || parsed.value === false) {
            this.#beforeCallStartResult = parsed.value;
          } else if (parsed.value === "throw") {
            this.#beforeCallStartResult = "throw";
          }
          connection.send(
            JSON.stringify({ type: "_ack", command: parsed.type })
          );
          break;
        case "_hold_call_start":
          {
            let resolve = () => {};
            const promise = new Promise<void>((done) => {
              resolve = done;
            });
            this.#callStartGate = { promise, resolve };
          }
          connection.send(
            JSON.stringify({ type: "_ack", command: parsed.type })
          );
          break;
        case "_release_call_start":
          this.#callStartGate?.resolve();
          this.#callStartGate = null;
          connection.send(
            JSON.stringify({ type: "_ack", command: parsed.type })
          );
          break;
        case "_set_keep_alive_throw":
          this.#keepAliveShouldThrow = parsed.value === true;
          connection.send(
            JSON.stringify({ type: "_ack", command: parsed.type })
          );
          break;
        case "_set_turn_delay":
          this.#turnDelayMs = parsed.value;
          connection.send(
            JSON.stringify({ type: "_ack", command: parsed.type })
          );
          break;
        case "_set_turn_mode":
          if (
            parsed.value === "normal" ||
            parsed.value === "reject" ||
            parsed.value === "until_abort"
          ) {
            this.#turnMode = parsed.value;
          }
          connection.send(
            JSON.stringify({ type: "_ack", command: parsed.type })
          );
          break;
        case "_set_tts_mode":
          if (parsed.value === "controlled") {
            this.tts = this.#controlledTTS;
            this.#streamTurns = true;
          } else if (parsed.value === "normal") {
            this.tts = new TestTTS();
            this.#streamTurns = false;
          }
          connection.send(
            JSON.stringify({ type: "_ack", command: parsed.type })
          );
          break;
        case "_release_tts":
          this.#controlledTTS.release();
          connection.send(
            JSON.stringify({ type: "_ack", command: parsed.type })
          );
          break;
        case "_get_turn_state":
          connection.send(
            JSON.stringify({
              type: "_turn_state",
              transcripts: this.#turnTranscripts,
              abortCount: this.#turnAbortCount
            })
          );
          break;
        case "_set_transcriber_mode":
          if (isTestTranscriberMode(parsed.value)) {
            this.#transcriberMode = parsed.value;
            this.#lastReadySession = null;
            this.transcriber =
              parsed.value === "missing" ? undefined : new TestTranscriber();
          }
          connection.send(
            JSON.stringify({ type: "_ack", command: parsed.type })
          );
          break;
        case "_resolve_transcriber_ready":
          this.#lastReadySession?.resolveReady();
          connection.send(
            JSON.stringify({ type: "_ack", command: parsed.type })
          );
          break;
        case "_reject_transcriber_ready":
          this.#lastReadySession?.rejectReady();
          connection.send(
            JSON.stringify({ type: "_ack", command: parsed.type })
          );
          break;
        case "_reject_transcriber_ready_at":
          if (typeof parsed.index === "number") {
            this.#readySessions[parsed.index]?.rejectReady();
          }
          connection.send(
            JSON.stringify({ type: "_ack", command: parsed.type })
          );
          break;
        case "_set_audio_transport":
          this.#useAudioTransport = parsed.value === true;
          this.#audioTransport.events = [];
          connection.send(
            JSON.stringify({ type: "_ack", command: parsed.type })
          );
          break;
        case "_transport_ingress":
          if (typeof parsed.byteLength === "number") {
            this.#audioTransport.emit(parsed.byteLength);
          }
          connection.send(
            JSON.stringify({ type: "_ack", command: parsed.type })
          );
          break;
        case "_get_transport_events":
          connection.send(
            JSON.stringify({
              type: "_transport_events",
              events: this.#audioTransport.events
            })
          );
          break;
        case "_get_counts":
          connection.send(
            JSON.stringify({
              type: "_counts",
              callStart: this.#callStartCount,
              callStartResumed: this.#callStartResumed,
              callEnd: this.#callEndCount,
              interrupt: this.#interruptCount,
              keepAliveAcquired: this.#keepAliveAcquiredCount,
              keepAliveReleased: this.#keepAliveReleasedCount
            })
          );
          break;
        case "_get_message_count":
          connection.send(
            JSON.stringify({
              type: "_message_count",
              count: this.getMessageCount()
            })
          );
          break;
        case "_get_agent_context":
          const contexts =
            this.transcriber instanceof TestTranscriber
              ? (this.transcriber.lastSession?.agentContexts ?? [])
              : [];
          connection.send(
            JSON.stringify({
              type: "_agent_context",
              contexts
            })
          );
          break;
        case "_emit_eager":
          if (
            typeof parsed.text === "string" &&
            this.transcriber instanceof TestTranscriber
          ) {
            this.transcriber.lastSession?.emitEager(parsed.text);
          }
          break;
        case "_emit_speech_start":
          if (this.transcriber instanceof TestTranscriber) {
            this.transcriber.lastSession?.emitSpeechStart(
              typeof parsed.text === "string" ? parsed.text : undefined
            );
          }
          break;
        case "_emit_turn_resumed":
          if (this.transcriber instanceof TestTranscriber) {
            this.transcriber.lastSession?.emitTurnResumed(
              typeof parsed.text === "string" ? parsed.text : undefined
            );
          }
          break;
        case "_emit_end":
          if (
            typeof parsed.text === "string" &&
            this.transcriber instanceof TestTranscriber
          ) {
            this.transcriber.lastSession?.emitEnd(parsed.text);
          }
          break;
        case "_force_end_call":
          this.forceEndCall(connection);
          break;
      }
    } catch {
      // ignore
    }
  }

  getMessageCount(): number {
    return this.getConversationHistory(Number.MAX_SAFE_INTEGER).length;
  }
  getTurnStateForTest(): { transcripts: string[]; abortCount: number } {
    return {
      transcripts: [...this.#turnTranscripts],
      abortCount: this.#turnAbortCount
    };
  }

  async exerciseAbruptTransportCloseForTest(): Promise<string[]> {
    this.#useAudioTransport = true;
    this.#audioTransport.events.length = 0;

    const connection = {
      id: "abrupt-test",
      send() {}
    } as unknown as Connection;

    this.onMessage(connection, JSON.stringify({ type: "start_call" }));
    for (let i = 0; i < 20 && this.#audioTransport.events.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await this.onClose(connection);
    await new Promise((resolve) => setTimeout(resolve, 0));
    return [...this.#audioTransport.events];
  }

  async exerciseWebSocketPlaybackForTest(): Promise<boolean> {
    this.#useAudioTransport = false;
    let sentBinary = false;
    const connection = {
      id: "websocket-playback-test",
      send(data: string | ArrayBuffer) {
        if (data instanceof ArrayBuffer) sentBinary = true;
      }
    } as unknown as Connection;

    this.onMessage(connection, JSON.stringify({ type: "start_call" }));
    for (let i = 0; i < 20 && this.#callStartCount === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await this.speak(connection, "fallback");
    await this.onClose(connection);
    return sentBinary;
  }

  getAudioTransportEventsForTest(): string[] {
    return [...this.#audioTransport.events];
  }
}
/** VoiceAgent fixture with durable message persistence enabled. */
export class TestPersistentVoiceAgent extends PersistentVoiceBase {}

/**
 * Test VoiceAgent that returns empty strings from onTurn.
 * Used to test the empty response guard.
 */
export class TestEmptyResponseVoiceAgent extends VoiceBase {
  static options = { hibernate: false };

  transcriber = new TestTranscriber();
  tts = new TestTTS();
  #responseMode:
    | "empty_string"
    | "empty_stream"
    | "whitespace_stream"
    | "leading_whitespace_stream" = "empty_string";

  async onTurn(
    _transcript: string,
    _context: VoiceTurnContext
  ): Promise<string | AsyncIterable<string>> {
    if (this.#responseMode === "empty_stream") {
      return (async function* () {})();
    }
    if (this.#responseMode === "whitespace_stream") {
      return (async function* () {
        yield "   ";
      })();
    }
    if (this.#responseMode === "leading_whitespace_stream") {
      return (async function* () {
        yield "   ";
        yield "Hello";
        yield " world.";
      })();
    }

    return "";
  }

  onMessage(connection: Connection, message: WSMessage) {
    if (typeof message !== "string") return;
    try {
      const parsed = JSON.parse(message);
      switch (parsed.type) {
        case "_set_response_mode":
          if (
            parsed.value === "empty_string" ||
            parsed.value === "empty_stream" ||
            parsed.value === "whitespace_stream" ||
            parsed.value === "leading_whitespace_stream"
          ) {
            this.#responseMode = parsed.value;
          }
          connection.send(
            JSON.stringify({ type: "_ack", command: parsed.type })
          );
          break;
        case "_get_message_count":
          connection.send(
            JSON.stringify({
              type: "_message_count",
              count: this.getMessageCount()
            })
          );
          break;
      }
    } catch {
      // ignore
    }
  }

  getMessageCount(): number {
    return this.getConversationHistory(Number.MAX_SAFE_INTEGER).length;
  }
}

/**
 * Reports the conversation history supplied to onTurn through its response.
 * This lets protocol-level tests verify the VoiceTurnContext contract.
 */
export class TestContextVoiceAgent extends VoiceBase {
  static options = { hibernate: false };

  transcriber = new TestTranscriber();
  tts = new TestTTS();

  async onTurn(
    _transcript: string,
    context: VoiceTurnContext
  ): Promise<string> {
    return JSON.stringify(context.messages);
  }
}

export class TestAiSdkFullStreamVoiceAgent extends VoiceBase {
  static options = { hibernate: false };

  transcriber = new TestTranscriber();
  tts = new TestTTS();
  #mockResponse = defaultMockTextStreamResponse;

  async onTurn(_transcript: string, _context: VoiceTurnContext) {
    const result = streamText({
      model: createToolCallingTextStreamModel(this.#mockResponse),
      tools: createMockTools(this.#mockResponse),
      stopWhen: isStepCount(3),
      prompt: "Check the weather, then answer."
    });

    return result.stream;
  }

  onMessage(connection: Connection, message: WSMessage) {
    if (typeof message !== "string") return;
    try {
      const parsed = JSON.parse(message) as Record<string, unknown>;
      if (parsed.type === "_set_mock_response") {
        if (isMockTextStreamResponse(parsed.response)) {
          this.#mockResponse = parsed.response;
        }
        connection.send(JSON.stringify({ type: "_ack", command: parsed.type }));
      }
    } catch {
      // ignore
    }
  }
}

export class TestAiSdkTextStreamVoiceAgent extends VoiceBase {
  static options = { hibernate: false };

  transcriber = new TestTranscriber();
  tts = new TestTTS();
  #mockResponse = defaultMockTextStreamResponse;

  async onTurn(_transcript: string, _context: VoiceTurnContext) {
    const result = streamText({
      model: createToolCallingTextStreamModel(this.#mockResponse),
      tools: createMockTools(this.#mockResponse),
      stopWhen: isStepCount(3),
      prompt: "Check the weather, then answer."
    });

    return result.textStream;
  }

  onMessage(connection: Connection, message: WSMessage) {
    if (typeof message !== "string") return;
    try {
      const parsed = JSON.parse(message) as Record<string, unknown>;
      if (parsed.type === "_set_mock_response") {
        if (isMockTextStreamResponse(parsed.response)) {
          this.#mockResponse = parsed.response;
        }
        connection.send(JSON.stringify({ type: "_ack", command: parsed.type }));
      }
    } catch {
      // ignore
    }
  }
}

/**
 * Test VoiceAgent configured for native 24kHz pcm16 payloads
 * (e.g. Gemini TTS). Verifies sampleRate is declared in audio_config.
 */
export class TestPcm24kVoiceAgent extends Pcm24kVoiceBase {
  static options = { hibernate: false };

  transcriber = new TestTranscriber();
  tts = new TestTTS();

  async onTurn(
    transcript: string,
    _context: VoiceTurnContext
  ): Promise<string> {
    return `Echo: ${transcript}`;
  }
}

/**
 * Test VoiceAgent configured with `minInterruptWords: 3`. Holds its
 * pipeline open until the abort signal fires, so tests can verify short
 * transcripts (`_emit_eager`) are ignored while longer ones interrupt.
 */
export class TestMinInterruptVoiceAgent extends MinInterruptVoiceBase {
  static options = { hibernate: false };

  transcriber = new TestTranscriber();
  tts = new TestTTS();

  async onTurn(transcript: string, context: VoiceTurnContext): Promise<string> {
    await new Promise<void>((resolve) => {
      context.signal.addEventListener("abort", () => resolve());
    });
    return `Echo: ${transcript}`;
  }

  #interruptCount = 0;

  onInterrupt(_connection: Connection): void {
    this.#interruptCount++;
  }

  onMessage(connection: Connection, message: WSMessage) {
    if (typeof message !== "string") return;
    try {
      const parsed = JSON.parse(message) as Record<string, unknown>;
      switch (parsed.type) {
        case "_emit_speech_start":
          if (this.transcriber instanceof TestTranscriber) {
            this.transcriber.lastSession?.emitSpeechStart(
              typeof parsed.text === "string" ? parsed.text : undefined
            );
          }
          break;
        case "_get_counts":
          connection.send(
            JSON.stringify({ type: "_counts", interrupt: this.#interruptCount })
          );
          break;
      }
    } catch {
      // ignore
    }
  }
}

/**
 * Test VoiceAgent whose TTS provider streams audio via synthesizeStream,
 * exercising the restored StreamingTTSProvider branch in the TTS pipeline.
 */
export class TestStreamingTtsVoiceAgent extends VoiceBase {
  static options = { hibernate: false };

  transcriber = new TestTranscriber();
  #streamingTTS = new TestStreamingTTS();
  tts = this.#streamingTTS;

  async onTurn(
    transcript: string,
    _context: VoiceTurnContext
  ): Promise<AsyncIterable<string>> {
    // A streamed (non-string) response is required to reach the
    // #streamingTTSPipeline where synthesizeStream is invoked.
    return (async function* () {
      yield "Echo:";
      yield ` ${transcript}`;
    })();
  }

  onMessage(connection: Connection, message: WSMessage) {
    if (typeof message !== "string") return;
    try {
      const parsed = JSON.parse(message) as Record<string, unknown>;
      if (parsed.type === "_get_streaming_tts_chunks") {
        connection.send(
          JSON.stringify({
            type: "_streaming_tts_chunks",
            chunks: this.#streamingTTS.chunks
          })
        );
      }
    } catch {
      // ignore
    }
  }
}

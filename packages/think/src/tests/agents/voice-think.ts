import { tool, type LanguageModel, type ToolSet, type UIMessage } from "ai";
import { z } from "zod";
import { createVoiceThink, voiceChannel } from "../../voice";
import type { Connection } from "agents";
import type {
  Transcriber,
  TranscriberSession,
  TranscriberSessionOptions,
  TTSProvider,
  VoiceInterruptContext,
  VoiceTurnContext
} from "agents/voice";
import { Think } from "../../think";

class TestTTS implements TTSProvider {
  async synthesize(text: string): Promise<ArrayBuffer> {
    return new TextEncoder().encode(text).buffer;
  }
}

class TestTranscriberSession implements TranscriberSession {
  readonly #options: TranscriberSessionOptions;
  #closed = false;

  constructor(options: TranscriberSessionOptions = {}) {
    this.#options = options;
  }

  feed(_chunk: ArrayBuffer): void {
    if (this.#closed) return;
    this.#options.onSpeechStart?.();
    this.#options.onUtterance?.("hello from voice");
  }

  close(): void {
    this.#closed = true;
  }
}

class TestTranscriber implements Transcriber {
  lastSession: TestTranscriberSession | undefined;

  createSession(options?: TranscriberSessionOptions): TranscriberSession {
    this.lastSession = new TestTranscriberSession(options);
    return this.lastSession;
  }
}

function modelResponse(
  response: string,
  onCall: (prompt: unknown) => void = () => {},
  callTool = false
): LanguageModel {
  let calls = 0;
  return {
    specificationVersion: "v3",
    provider: "think-voice-test",
    modelId: "think-voice-test",
    supportedUrls: {},
    doGenerate() {
      throw new Error("doGenerate is not used by this fixture");
    },
    doStream({ prompt }: { prompt: unknown }) {
      onCall(prompt);
      const useTool = callTool && calls++ === 0;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          if (useTool) {
            controller.enqueue({
              type: "tool-call",
              toolCallId: "voice-tool",
              toolName: "record",
              input: "{}"
            });
          } else {
            controller.enqueue({ type: "text-start", id: "voice-text" });
            controller.enqueue({
              type: "text-delta",
              id: "voice-text",
              delta: response
            });
            controller.enqueue({ type: "text-end", id: "voice-text" });
          }
          controller.enqueue({
            type: "finish",
            finishReason: {
              unified: useTool ? "tool-calls" : "stop",
              raw: undefined
            },
            usage: {
              inputTokens: {
                total: 1,
                noCache: 1,
                cacheRead: 0,
                cacheWrite: 0
              },
              outputTokens: { total: 1, text: 1, reasoning: 0 }
            }
          });
          controller.close();
        }
      });
      return Promise.resolve({ stream });
    }
  } as LanguageModel;
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const VoiceThink = createVoiceThink({ channel: "voice" });

export class ThinkVoiceTestAgent extends VoiceThink {
  private _voiceMetadataCalls = 0;
  private _response = "voice answer";
  private _toolMode = false;
  private _toolExecutions = 0;
  private _modelCalls = 0;
  private _modelStarted = deferred<void>();
  private _lastPrompt: unknown;
  private _heldTool?: {
    started: Deferred<void>;
    release: Deferred<void>;
  };
  readonly #transcriber = new TestTranscriber();
  readonly #tts = new TestTTS();

  override configureChannels() {
    return {
      voice: voiceChannel({
        transcriber: this.#transcriber,
        tts: this.#tts,
        instructions: "Test voice instructions"
      })
    };
  }

  override getModel(): LanguageModel {
    return modelResponse(
      this._response,
      (prompt) => {
        this._lastPrompt = prompt;
        this._modelCalls++;
        this._modelStarted.resolve();
      },
      this._toolMode
    );
  }

  override getTools(): ToolSet {
    if (!this._toolMode) return {};
    return {
      record: tool({
        inputSchema: z.object({}),
        execute: async () => {
          const gate = this._heldTool;
          gate?.started.resolve();
          await gate?.release.promise;
          this._toolExecutions++;
          return "recorded";
        }
      })
    };
  }

  async setVoiceResponseForTest(response: string): Promise<void> {
    this._response = response;
  }

  override getVoiceTurnMetadata(
    transcript: string,
    context: VoiceTurnContext
  ): Record<string, unknown> {
    this._voiceMetadataCalls++;
    return { transcript, uri: context.connection.uri };
  }

  async runVoiceOnTurnForTest(input: string, uri: string): Promise<string> {
    const stream = await this.onTurn(input, {
      connection: { id: "voice-test", uri } as Connection,
      messages: [],
      signal: new AbortController().signal
    });
    if (
      typeof stream !== "object" ||
      stream === null ||
      !(Symbol.asyncIterator in stream)
    ) {
      throw new TypeError("Expected an async Voice Think stream");
    }
    let text = "";
    for await (const chunk of stream) {
      if (
        typeof chunk === "object" &&
        chunk !== null &&
        "type" in chunk &&
        chunk.type === "text-delta" &&
        "delta" in chunk &&
        typeof chunk.delta === "string"
      ) {
        text += chunk.delta;
      }
    }
    return text;
  }
  async reconcileInterruptedVoiceTurnForTest(
    spokenText?: string,
    eager = false
  ): Promise<string> {
    const connection = {
      id: "interrupted-voice-test",
      uri: "https://example.com/voice"
    } as Connection;
    const controller = new AbortController();
    this._modelStarted = deferred<void>();
    await this.onTurn("interrupted question", {
      connection,
      messages: [],
      signal: controller.signal,
      ...(eager && { confirmation: Promise.resolve(true) })
    });
    await this._modelStarted.promise;
    controller.abort("caller interrupted playback");
    await this.onInterrupt(connection, {
      spokenText
    } satisfies VoiceInterruptContext);
    const stored = await this.session.getHistory();
    await this.runVoiceOnTurnForTest("follow up", "https://example.com/voice");
    return JSON.stringify({ stored, nextPrompt: this._lastPrompt });
  }

  async runIdleVoiceInterruptForTest(): Promise<string> {
    await this.runVoiceOnTurnForTest(
      "completed question",
      "https://example.com/voice"
    );
    const before = await this.session.getHistory();
    await this.onInterrupt({ id: "voice-test" } as Connection, {});
    return JSON.stringify({ before, after: await this.session.getHistory() });
  }
  async runEagerVoiceTurnForTest(
    input: string,
    confirmed: boolean,
    withTool = false
  ): Promise<string> {
    this._toolMode = withTool;
    const modelCallsBefore = this._modelCalls;
    this._modelStarted = deferred<void>();
    const controller = new AbortController();
    const outcome = deferred<boolean>();
    const stream = await this.onTurn(input, {
      connection: {
        id: "eager-voice-test",
        uri: "https://example.com/voice"
      } as Connection,
      messages: [],
      signal: controller.signal,
      confirmation: outcome.promise
    });
    await this._modelStarted.promise;
    const pending = await this.session.getHistory();
    const pendingToolExecutions = this._toolExecutions;
    outcome.resolve(confirmed);
    if (!confirmed) {
      controller.abort("eager transcript rejected");
      await this.onInterrupt({ id: "eager-voice-test" } as Connection, {
        spokenText: ""
      });
    }
    let text = "";
    if (
      typeof stream !== "object" ||
      stream === null ||
      !(Symbol.asyncIterator in stream)
    ) {
      throw new TypeError("Expected an async Voice Think stream");
    }
    for await (const chunk of stream) {
      if (
        typeof chunk === "object" &&
        chunk !== null &&
        "type" in chunk &&
        chunk.type === "text-delta" &&
        "delta" in chunk &&
        typeof chunk.delta === "string"
      ) {
        text += chunk.delta;
      }
    }
    return JSON.stringify({
      pending,
      stored: await this.session.getHistory(),
      modelCalls: this._modelCalls - modelCallsBefore,
      pendingToolExecutions,
      toolExecutions: this._toolExecutions,
      text
    });
  }

  async runInterruptedToolVoiceTurnForTest(
    eager: boolean,
    spokenText?: string
  ): Promise<string> {
    this._toolMode = true;
    const gate = {
      started: deferred<void>(),
      release: deferred<void>()
    };
    this._heldTool = gate;
    const connection = {
      id: "tool-interruption-test",
      uri: "https://example.com/voice"
    } as Connection;
    const controller = new AbortController();
    const confirmation = eager ? deferred<boolean>() : undefined;
    const output = await this.onTurn("use the slow tool", {
      connection,
      messages: [],
      signal: controller.signal,
      ...(confirmation && { confirmation: confirmation.promise })
    });
    confirmation?.resolve(true);
    await gate.started.promise;
    controller.abort("caller spoke over the running tool");
    const interrupted = this.onInterrupt(connection, { spokenText });
    gate.release.resolve();
    await interrupted;
    if (
      typeof output !== "object" ||
      output === null ||
      !(Symbol.asyncIterator in output)
    ) {
      throw new TypeError("Expected an async Voice Think stream");
    }
    const next = await output[Symbol.asyncIterator]().next();
    return JSON.stringify({
      stored: await this.session.getHistory(),
      toolExecutions: this._toolExecutions,
      outputDiscarded: next.done
    });
  }

  async getVoiceMetadataCallsForTest(): Promise<number> {
    return this._voiceMetadataCalls;
  }

  async runVoiceTurnForTest(input: string): Promise<void> {
    await this.runTurn({ input, channel: "voice" });
  }

  async getStoredMessages(): Promise<UIMessage[]> {
    return this.getMessages();
  }

  async getVoiceSqlTables(): Promise<string[]> {
    return this.sql<{ name: string }>`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name LIKE 'cf_voice_%'
      ORDER BY name
    `.map((row) => row.name);
  }
}
export class ThinkNoticeSurfaceTestAgent extends Think {
  readonly notices: string[] = [];

  override configureChannels() {
    return {
      custom: {
        kind: "custom" as const,
        ingress: { transport: "websocket" as const }
      }
    };
  }

  protected override async resolveChannelDeliverySurface(channelId: string) {
    if (channelId !== "custom") return undefined;
    return {
      post: async (message: string | { markdown: string }) => {
        this.notices.push(
          typeof message === "string" ? message : message.markdown
        );
      }
    };
  }

  async deliverNoticeErrorForTest(
    text: string,
    channel?: string
  ): Promise<string | null> {
    try {
      await this.deliverNotice(text, { channel });
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  async deliverCustomNotice(text: string): Promise<void> {
    await this.deliverNotice(text, { channel: "custom" });
  }

  async getNotices(): Promise<string[]> {
    return [...this.notices];
  }
}

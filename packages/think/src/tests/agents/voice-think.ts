import type { LanguageModel, UIMessage } from "ai";
import { createVoiceThink, voiceChannel } from "../../voice";
import type { Connection } from "agents";
import type {
  Transcriber,
  TranscriberSession,
  TranscriberSessionOptions,
  TTSProvider,
  VoiceTurnContext
} from "@cloudflare/voice";
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

function modelResponse(response: string): LanguageModel {
  return {
    specificationVersion: "v3",
    provider: "think-voice-test",
    modelId: "think-voice-test",
    supportedUrls: {},
    doGenerate() {
      throw new Error("doGenerate is not used by this fixture");
    },
    doStream() {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: "voice-text" });
          controller.enqueue({
            type: "text-delta",
            id: "voice-text",
            delta: response
          });
          controller.enqueue({ type: "text-end", id: "voice-text" });
          controller.enqueue({
            type: "finish",
            finishReason: { unified: "stop", raw: undefined },
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

const VoiceThink = createVoiceThink({ channel: "voice" });

export class ThinkVoiceTestAgent extends VoiceThink {
  private _voiceMetadataCalls = 0;

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
    return modelResponse("voice answer");
  }

  override getVoiceTurnMetadata(
    transcript: string,
    context: VoiceTurnContext
  ): Record<string, unknown> {
    this._voiceMetadataCalls++;
    return { transcript, uri: context.connection.uri };
  }

  async runVoiceOnTurnForTest(input: string, uri: string): Promise<void> {
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
    for await (const _chunk of stream) {
      // Consume the stream so the Think turn and metadata stamp complete.
    }
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

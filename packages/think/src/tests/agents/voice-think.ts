import type { LanguageModel, UIMessage } from "ai";
import { createVoiceThink, voiceChannel } from "../../voice";
import type { Connection } from "agents";
import type {
  Transcriber,
  TranscriberSession,
  TranscriberSessionOptions,
  TTSProvider,
  VoicePlaybackMarkerMessage,
  VoiceServerAudioTransport,
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
class TestPlaybackTextTransport implements VoiceServerAudioTransport {
  started = false;
  readonly pending: string[] = [];
  readonly played: string[] = [];

  start(): void {
    this.started = true;
  }

  send(): void {}
  flush(): void {}

  interrupt(): void {
    this.pending.length = 0;
  }

  stop(): void {
    this.started = false;
    this.pending.length = 0;
    this.played.length = 0;
  }

  resetPlaybackText(): void {
    this.played.length = 0;
  }

  markPlaybackText(_connectionId: string, text: string): void {
    this.pending.push(text);
  }

  getPlaybackText(): string {
    return this.played.join(" ");
  }

  drainOne(): string | undefined {
    const text = this.pending.shift();
    if (text) this.played.push(text);
    return text;
  }
}

function modelResponse(
  response: string,
  onPrompt: (prompt: string) => void = () => {}
): LanguageModel {
  return {
    specificationVersion: "v3",
    provider: "think-voice-test",
    modelId: "think-voice-test",
    supportedUrls: {},
    doGenerate() {
      throw new Error("doGenerate is not used by this fixture");
    },
    doStream(options) {
      onPrompt(JSON.stringify(options.prompt));
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
  private _response = "voice answer";

  private _lastModelPrompt = "";
  private _voiceConnection: Connection | null = null;
  private _useClientPlaybackMarkerAcks = false;
  private _voiceListening = false;
  readonly #transcriber = new TestTranscriber();
  readonly #tts = new TestTTS();
  readonly #playbackTextTransport = new TestPlaybackTextTransport();
  readonly #clientPlaybackMarkers: VoicePlaybackMarkerMessage[] = [];

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
    return modelResponse(this._response, (prompt) => {
      this._lastModelPrompt = prompt;
    });
  }
  override createAudioTransport(): VoiceServerAudioTransport | null {
    return this._useClientPlaybackMarkerAcks
      ? null
      : this.#playbackTextTransport;
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

  async getVoiceMetadataCallsForTest(): Promise<number> {
    return this._voiceMetadataCalls;
  }

  async runVoiceTurnForTest(input: string): Promise<void> {
    await this.runTurn({ input, channel: "voice" });
  }
  async useClientPlaybackMarkerAcksForTest(): Promise<void> {
    if (this._voiceConnection) throw new Error("Voice call already started");
    this._useClientPlaybackMarkerAcks = true;
  }

  async runMarkedVoiceTurnForTest(input: string): Promise<void> {
    if (!this._voiceConnection) {
      this._voiceConnection = {
        id: "marked-voice-test",
        uri: "https://example.com/voice",
        send: (message: unknown) => {
          if (typeof message !== "string") return;
          try {
            const parsed = JSON.parse(message) as Record<string, unknown>;
            if (parsed.type === "status" && parsed.status === "listening") {
              this._voiceListening = true;
            }
            if (
              parsed.type === "playback_marker" &&
              typeof parsed.playbackId === "string" &&
              typeof parsed.sequence === "number" &&
              typeof parsed.text === "string"
            ) {
              this.#clientPlaybackMarkers.push({
                type: "playback_marker",
                playbackId: parsed.playbackId,
                sequence: parsed.sequence,
                text: parsed.text
              });
            }
          } catch {
            // Ignore non-JSON server messages in this test connection.
          }
        }
      } as unknown as Connection;
      this.onMessage(
        this._voiceConnection,
        JSON.stringify(
          this._useClientPlaybackMarkerAcks
            ? {
                type: "start_call",
                playback_markers: true,
                playback_marker_acks: true
              }
            : { type: "start_call" }
        )
      );
      for (
        let attempt = 0;
        attempt < 100 &&
        (this._useClientPlaybackMarkerAcks
          ? !this._voiceListening
          : !this.#playbackTextTransport.started);
        attempt++
      ) {
        await scheduler.wait(0);
      }
    }
    if (this._useClientPlaybackMarkerAcks) {
      this.#clientPlaybackMarkers.length = 0;
    }
    this.onMessage(
      this._voiceConnection,
      JSON.stringify({ type: "text_message", text: input })
    );
    for (let attempt = 0; attempt < 100; attempt++) {
      const latest = (await this.getMessages()).at(-1);
      const text = latest?.parts
        .filter(
          (part): part is { type: "text"; text: string } => part.type === "text"
        )
        .map((part) => part.text)
        .join("");
      const hasPlaybackMarker = this._useClientPlaybackMarkerAcks
        ? this.#clientPlaybackMarkers.length > 0
        : this.#playbackTextTransport.pending.length > 0;
      if (
        latest?.role === "assistant" &&
        text === this._response &&
        hasPlaybackMarker
      ) {
        return;
      }
      await scheduler.wait(0);
    }
    throw new Error("Timed out waiting for marked voice turn");
  }

  async drainOnePlaybackMarkerForTest(): Promise<string | undefined> {
    return this.#playbackTextTransport.drainOne();
  }

  async ackOneClientPlaybackMarkerForTest(): Promise<string | undefined> {
    if (!this._voiceConnection) throw new Error("Voice call not started");
    const marker = this.#clientPlaybackMarkers.shift();
    if (!marker) return undefined;
    this.onMessage(
      this._voiceConnection,
      JSON.stringify({
        type: "playback_marker_ack",
        playbackId: marker.playbackId,
        sequence: marker.sequence
      })
    );
    return marker.text;
  }

  async interruptMarkedVoiceTurnForTest(): Promise<void> {
    if (!this._voiceConnection) throw new Error("Voice call not started");
    const playedText = this.getPlaybackText(this._voiceConnection.id) ?? "";
    this.onMessage(
      this._voiceConnection,
      JSON.stringify({ type: "interrupt" })
    );
    for (let attempt = 0; attempt < 100; attempt++) {
      const latest = (await this.getMessages()).at(-1);
      const text = latest?.parts
        .filter(
          (part): part is { type: "text"; text: string } => part.type === "text"
        )
        .map((part) => part.text)
        .join("");
      if (
        (playedText && latest?.role === "assistant" && text === playedText) ||
        (!playedText && latest?.role !== "assistant")
      ) {
        return;
      }
      await scheduler.wait(0);
    }
    throw new Error("Timed out waiting for interrupted voice finalization");
  }

  async getLastModelPromptForTest(): Promise<string> {
    return this._lastModelPrompt;
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

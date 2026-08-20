import {
  EMPTY_MESSENGER_RESPONSE,
  ERROR_MESSENGER_RESPONSE,
  INTERRUPTED_MESSENGER_RESPONSE,
  TextStreamCallback
} from "./messengers/delivery";
import type {
  ChannelDefinition,
  ChannelDeliverySurface,
  NormalizedChannelDefinition
} from "./channels";
import { Think } from "./think";
import { withSFUVoiceTransport, withVoice } from "@cloudflare/voice";
import type {
  SFUConfig,
  StreamingTTSProvider,
  TextSource,
  Transcriber,
  VoiceAgentMixinMembers,
  VoiceAgentOptions,
  VoiceTurnContext,
  TTSProvider
} from "@cloudflare/voice";
export type VoiceChannelOptions = Omit<
  ChannelDefinition,
  "kind" | "ingress" | "capabilities"
> & {
  transcriber: Transcriber;
  tts: TTSProvider & Partial<StreamingTTSProvider>;
};

export type VoiceChannelDefinition = VoiceChannelOptions & {
  kind: "voice";
  ingress: { transport: "voice" };
  capabilities: { canStream: true };
};

export function voiceChannel(
  options: VoiceChannelOptions
): VoiceChannelDefinition {
  return {
    ...options,
    kind: "voice",
    ingress: { transport: "voice" },
    capabilities: { canStream: true }
  };
}

export type CreateVoiceThinkOptions = Omit<
  VoiceAgentOptions,
  "persistMessages"
> & { channel?: string };

export type CreateSFUVoiceThinkOptions = Omit<
  CreateVoiceThinkOptions,
  "audioFormat"
> & {
  routePrefix?: string;
};

export type VoiceThinkConstructor<
  Env extends Cloudflare.Env = Cloudflare.Env,
  State = unknown,
  Props extends Record<string, unknown> = Record<string, unknown>
> = new (
  ctx: DurableObjectState,
  env: Env
) => Think<Env, State, Props> &
  VoiceAgentMixinMembers & {
    getVoiceTurnMetadata(
      transcript: string,
      context: VoiceTurnContext
    ): Record<string, unknown> | undefined;
    onTurn(transcript: string, context: VoiceTurnContext): Promise<TextSource>;
  };

export type SFUVoiceThinkConstructor<
  Env extends Cloudflare.Env = Cloudflare.Env,
  State = unknown,
  Props extends Record<string, unknown> = Record<string, unknown>
> = new (
  ctx: DurableObjectState,
  env: Env
) => Think<Env, State, Props> &
  VoiceAgentMixinMembers & {
    getVoiceTurnMetadata(
      transcript: string,
      context: VoiceTurnContext
    ): Record<string, unknown> | undefined;
    getSFUConfig(): SFUConfig;
    onTurn(transcript: string, context: VoiceTurnContext): Promise<TextSource>;
  };

class VoiceChannelTextStream implements AsyncIterable<unknown> {
  readonly #callback: TextStreamCallback;
  readonly #policy: VoiceChannelDefinition["delivery"];
  readonly #chunks: unknown[] = [];
  readonly #waiters: Array<(result: IteratorResult<unknown>) => void> = [];
  #sourceClosed = false;
  #pendingPosts = 0;
  #postTail: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(
    callback: TextStreamCallback,
    policy: VoiceChannelDefinition["delivery"]
  ) {
    this.#callback = callback;
    this.#policy = policy;
    void this.#pump();
  }

  async post(
    message: string | { markdown: string } | AsyncIterable<string>
  ): Promise<void> {
    if (this.#closed) return;
    this.#pendingPosts++;
    const task = this.#postTail.then(async () => {
      const text = await textFromMessage(message);
      if (!text) return;
      this.#enqueue({ type: "voice-notice-boundary" });
      this.#enqueue({ type: "text-delta", delta: text });
      this.#enqueue({ type: "voice-notice-boundary" });
    });
    this.#postTail = task
      .catch(() => undefined)
      .finally(() => {
        this.#pendingPosts--;
        this.#maybeClose();
      });
    return task;
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return this;
  }

  next(): Promise<IteratorResult<unknown>> {
    const chunk = this.#chunks.shift();
    if (chunk !== undefined) {
      return Promise.resolve({ value: chunk, done: false });
    }
    if (this.#closed) {
      return Promise.resolve({ value: undefined, done: true });
    }
    return new Promise<IteratorResult<unknown>>((resolve) => {
      this.#waiters.push(resolve);
    });
  }

  async #pump(): Promise<void> {
    let error: unknown;
    try {
      for await (const text of this.#callback.stream()) {
        if (text) this.#enqueue({ type: "text-delta", delta: text });
      }
    } catch (caught) {
      error = caught;
    }

    const fallback = this.#callback.wasInterrupted()
      ? (this.#policy?.interruptedResponseText ??
        INTERRUPTED_MESSENGER_RESPONSE)
      : error
        ? (this.#policy?.errorResponseText ?? ERROR_MESSENGER_RESPONSE)
        : !this.#callback.hasText()
          ? (this.#policy?.emptyResponseText ?? EMPTY_MESSENGER_RESPONSE)
          : undefined;
    if (fallback) {
      this.#enqueue({ type: "text-delta", delta: fallback });
    }
    this.#sourceClosed = true;
    this.#maybeClose();
  }

  #enqueue(chunk: unknown): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter({ value: chunk, done: false });
    } else {
      this.#chunks.push(chunk);
    }
  }

  #maybeClose(): void {
    if (!this.#sourceClosed || this.#pendingPosts !== 0 || this.#closed) {
      return;
    }
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }
}

async function textFromMessage(
  message: string | { markdown: string } | AsyncIterable<string>
): Promise<string> {
  if (typeof message === "string") return message;
  if ("markdown" in message) return message.markdown;
  let text = "";
  for await (const chunk of message) text += chunk;
  return text;
}

function voiceDefinition(
  definition: NormalizedChannelDefinition | undefined,
  channel: string
): VoiceChannelDefinition {
  const candidate = definition as
    | (NormalizedChannelDefinition & Partial<VoiceChannelDefinition>)
    | undefined;
  if (
    !candidate ||
    candidate.kind !== "voice" ||
    candidate.ingress.transport !== "voice" ||
    typeof candidate.transcriber?.createSession !== "function" ||
    typeof candidate.tts?.synthesize !== "function"
  ) {
    throw new Error(
      `Think voice channel "${channel}" must provide transcriber and tts via voiceChannel()`
    );
  }
  return candidate as VoiceChannelDefinition;
}

export function createVoiceThink<
  Env extends Cloudflare.Env = Cloudflare.Env,
  State = unknown,
  Props extends Record<string, unknown> = Record<string, unknown>
>(
  options: CreateVoiceThinkOptions = {}
): VoiceThinkConstructor<Env, State, Props> {
  const channel = options.channel ?? "voice";
  const voiceOptions: VoiceAgentOptions = {
    ...options,
    persistMessages: false
  };

  class ThinkBase extends Think<Env, State, Props> {}
  const VoiceBase = withVoice(ThinkBase, voiceOptions);

  class VoiceThink extends VoiceBase {
    #activeVoiceStream?: VoiceChannelTextStream;
    #voiceConnections = new Set<string>();

    override async beforeCallStart(
      connection: Parameters<VoiceAgentMixinMembers["beforeCallStart"]>[0]
    ): Promise<boolean> {
      const definition = this.getChannelDefinition(channel);
      if (!definition) {
        throw new Error(`Think voice channel "${channel}" is not registered`);
      }
      const voice = voiceDefinition(definition, channel);
      this.transcriber = voice.transcriber;
      this.tts = voice.tts;
      const allowed = await super.beforeCallStart(connection);
      if (allowed) this.#voiceConnections.add(connection.id);
      return allowed;
    }

    override async onCallEnd(
      connection: Parameters<VoiceAgentMixinMembers["onCallEnd"]>[0]
    ): Promise<void> {
      this.#voiceConnections.delete(connection.id);
      await super.onCallEnd(connection);
    }

    onClose(
      connection: Parameters<VoiceAgentMixinMembers["beforeCallStart"]>[0]
    ): void {
      this.#voiceConnections.delete(connection.id);
    }

    getVoiceTurnMetadata(
      _transcript: string,
      _context: VoiceTurnContext
    ): Record<string, unknown> | undefined {
      return undefined;
    }

    async onTurn(
      transcript: string,
      context: VoiceTurnContext
    ): Promise<AsyncIterable<unknown>> {
      const definition = voiceDefinition(
        this.getChannelDefinition(channel),
        channel
      );
      const callback = new TextStreamCallback({
        visibleSoftLimit: definition.delivery?.visibleSoftLimit
      });
      const stream = new VoiceChannelTextStream(callback, definition.delivery);
      const previous = this.#activeVoiceStream;
      this.#activeVoiceStream = stream;
      const restore = this.bindActiveDeliverySurface(stream);
      const metadata = this.getVoiceTurnMetadata(transcript, context);
      void this.runTurn({
        input: transcript,
        channel,
        mode: "stream",
        callback,
        signal: context.signal,
        metadata
      })
        .catch((error: unknown) => callback.fail(error))
        .finally(() => {
          restore();
          this.#activeVoiceStream = previous;
        });
      return stream;
    }

    protected override async resolveChannelDeliverySurface(
      channelId: string,
      thread?: string
    ): Promise<ChannelDeliverySurface | undefined> {
      if (channelId !== channel) {
        return super.resolveChannelDeliverySurface(channelId, thread);
      }
      if (this.#voiceConnections.size === 0) return undefined;
      return {
        post: async (message) => {
          const text = await textFromMessage(message);
          if (text) await this.speakAll(text);
        }
      };
    }
  }

  return VoiceThink;
}

export function createSFUVoiceThink<
  Env extends Cloudflare.Env = Cloudflare.Env,
  State = unknown,
  Props extends Record<string, unknown> = Record<string, unknown>
>(
  options: CreateSFUVoiceThinkOptions = {}
): SFUVoiceThinkConstructor<Env, State, Props> {
  const { routePrefix, sampleRate, ...voiceOptions } = options;
  const VoiceBase = createVoiceThink<Env, State, Props>({
    ...voiceOptions,
    audioFormat: "pcm16",
    sampleRate: sampleRate ?? 24000
  });
  class ConcreteVoiceThink extends VoiceBase {}
  return withSFUVoiceTransport(ConcreteVoiceThink, {
    routePrefix,
    inputSampleRate: sampleRate ?? 24000
  });
}

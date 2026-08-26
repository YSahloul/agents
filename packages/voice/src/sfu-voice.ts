import type { Agent, Connection } from "agents";
import {
  withVoice,
  type VoiceAgentMixinMembers,
  type VoiceAgentOptions
} from "./voice-core";
import { SFUVoiceTransport, type SFUVoiceState } from "./sfu-transport";
import type { SFUConfig } from "./sfu-utils";
import type { VoiceServerAudioTransport } from "./types";

const SFU_STATE_KEY = "cf_voice_sfu_state";

export type SFUVoiceAgentOptions = Omit<VoiceAgentOptions, "audioFormat"> & {
  routePrefix?: string;
};

export interface SFUVoiceTransportOptions {
  routePrefix?: string;
  inputSampleRate?: number;
}

// Mixin constructors must accept and forward the base constructor's arguments.
// oxlint-disable-next-line @typescript-eslint/no-explicit-any
type Constructor<T = object> = new (...args: any[]) => T;

type VoiceAgentLike = Constructor<Agent> & Constructor<VoiceAgentMixinMembers>;

interface SFUVoiceAgentMixinMembers extends VoiceAgentMixinMembers {
  getSFUConfig(): SFUConfig;
}

type SFUVoiceAgentMixinReturn<TBase extends Constructor<Agent>> = TBase &
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any
  (new (...args: any[]) => SFUVoiceAgentMixinMembers);

export function withSFUVoiceTransport<TBase extends VoiceAgentLike>(
  Base: TBase,
  options?: SFUVoiceTransportOptions
): SFUVoiceAgentMixinReturn<TBase> {
  const normalizedPrefix =
    options?.routePrefix?.replace(/^\/+|\/+$/g, "") || "voice";
  const inputSampleRate = options?.inputSampleRate ?? 24000;

  class SFUVoiceAgentMixin extends Base {
    #transport: SFUVoiceTransport | null = null;

    // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- mixin constructor must forward base arguments
    constructor(...args: any[]) {
      super(...args);

      const consumerFetch = this.fetch.bind(this);
      this.fetch = async (request: Request) => {
        const path = new URL(request.url).pathname;
        if (
          request.method === "GET" &&
          request.headers.get("Upgrade")?.toLowerCase() === "websocket" &&
          (path.endsWith(`/${normalizedPrefix}/tts/subscribe`) ||
            path.endsWith(`/${normalizedPrefix}/stt/sfu-subscribe`))
        ) {
          const response =
            this.#getSFUTransport().handleWebSocketUpgrade(request);
          if (response) return response;
        }
        return consumerFetch(request);
      };

      const consumerOnRequest = this.onRequest.bind(this);
      this.onRequest = async (request: Request) => {
        const path = new URL(request.url).pathname;
        if (
          request.method === "POST" &&
          [
            "tts/publish",
            "rtc/connect",
            "rtc/pull",
            "rtc/renegotiate",
            "stt/start-forwarding",
            "stt/stop-forwarding"
          ].some((operation) =>
            path.endsWith(`/${normalizedPrefix}/${operation}`)
          )
        ) {
          const response =
            await this.#getSFUTransport().handleHttpRequest(request);
          if (response) return response;
        }
        return consumerOnRequest(request);
      };
    }

    getSFUConfig(): SFUConfig {
      throw new Error("SFU voice agent must implement getSFUConfig()");
    }

    createAudioTransport(_connection: Connection): VoiceServerAudioTransport {
      return this.#getSFUTransport();
    }

    #getSFUTransport(): SFUVoiceTransport {
      this.#transport ??= new SFUVoiceTransport({
        config: this.getSFUConfig(),
        routePrefix: normalizedPrefix,
        inputSampleRate,
        loadState: async () =>
          (await this.ctx.storage.get<SFUVoiceState>(SFU_STATE_KEY)) ?? null,
        saveState: async (state) => {
          if (state) {
            await this.ctx.storage.put(SFU_STATE_KEY, state);
          } else {
            await this.ctx.storage.delete(SFU_STATE_KEY);
          }
        }
      });
      return this.#transport;
    }
  }

  return SFUVoiceAgentMixin as SFUVoiceAgentMixinReturn<TBase>;
}

export function withSFUVoice<TBase extends Constructor<Agent>>(
  Base: TBase,
  options?: SFUVoiceAgentOptions
): SFUVoiceAgentMixinReturn<TBase> {
  const { routePrefix, sampleRate, ...voiceOptions } = options ?? {};
  const VoiceBase = withVoice(Base, {
    ...voiceOptions,
    audioFormat: "pcm16",
    sampleRate: sampleRate ?? 24000
  });
  return withSFUVoiceTransport(VoiceBase, {
    routePrefix,
    inputSampleRate: sampleRate ?? 24000
  });
}

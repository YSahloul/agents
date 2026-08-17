import type { Agent, Connection } from "agents";
import {
  withVoice,
  type VoiceAgentMixinMembers,
  type VoiceAgentOptions
} from "./voice";
import type { Transcriber, TTSProvider, StreamingTTSProvider } from "./types";

// oxlint-disable-next-line @typescript-eslint/no-explicit-any -- mixin constructor constraint
type Constructor<T = object> = new (...args: any[]) => T;
type AgentLike = Constructor<Agent<Cloudflare.Env>>;

export interface VoiceAgentFactoryConfig extends VoiceAgentOptions {
  /** Constructs the transcriber for this agent instance. Called once from a field initializer, after `this.env` is available. */
  stt: (env: Cloudflare.Env) => Transcriber;
  /** Constructs the TTS provider for this agent instance. Same lifecycle as `stt`. */
  tts: (env: Cloudflare.Env) => TTSProvider & Partial<StreamingTTSProvider>;
  /** Greeting spoken by the default `onCallStart()`. Omit to skip — a subclass may still override `onCallStart()` itself. */
  greeting?: string;
}

export interface VoiceAgentFactoryMixinMembers extends VoiceAgentMixinMembers {
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

type VoiceAgentFactoryReturn<TBase extends AgentLike> = TBase &
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- mixin constructor must accept any args
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
export function createVoiceAgent<TBase extends AgentLike>(
  Base: TBase,
  config: VoiceAgentFactoryConfig
): VoiceAgentFactoryReturn<TBase> {
  const { stt: sttFactory, tts: ttsFactory, greeting, ...voiceOptions } = config;
  const VoiceBase = withVoice(Base, voiceOptions);

  class VoiceAgentFactoryMixin extends VoiceBase {
    transcriber = sttFactory(this.env);
    tts = ttsFactory(this.env);
    callProps?: Record<string, unknown>;

    async onStart(props?: Record<string, unknown>) {
      if (props) this.callProps = props;
    }

    async onCallStart(connection: Connection) {
      if (greeting) await this.speak(connection, greeting);
    }
  }

  return VoiceAgentFactoryMixin as unknown as VoiceAgentFactoryReturn<TBase>;
}

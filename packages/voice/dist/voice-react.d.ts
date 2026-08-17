import {
  _ as VoiceStatus,
  l as VoiceAudioFormat,
  m as VoiceRole,
  p as VoicePipelineMetrics,
  s as TranscriptMessage,
  u as VoiceAudioInput,
  v as VoiceTransport
} from "./types-DN26t5k2.js";
import {
  a as WebSocketVoiceTransport,
  i as VoiceClientOptions,
  n as VoiceClientEvent,
  o as SFUVoiceAudioInput,
  r as VoiceClientEventMap,
  s as SFUVoiceAudioInputOptions
} from "./voice-client-DFYEae7d.js";

//#region src/voice-react.d.ts
/** Options accepted by useVoiceAgent. */
interface UseVoiceAgentOptions extends VoiceClientOptions {
  /**
   * Whether the hook should create and connect a VoiceClient.
   *
   * @default true
   */
  enabled?: boolean;
  /**
   * Called when the hook reconnects due to option changes (e.g., agent name
   * or instance name changed). Use this to show a toast or notification.
   */
  onReconnect?: () => void;
}
interface UseVoiceAgentReturn {
  status: VoiceStatus;
  transcript: TranscriptMessage[];
  /**
   * The current interim (partial) transcript from streaming STT.
   * Updates in real time as the user speaks. null when not available.
   */
  interimTranscript: string | null;
  metrics: VoicePipelineMetrics | null;
  audioLevel: number;
  isMuted: boolean;
  connected: boolean;
  error: string | null;
  outputDeviceError: string | null;
  startCall: () => Promise<void>;
  endCall: () => void;
  toggleMute: () => void;
  sendText: (text: string) => void;
  /** Send arbitrary JSON to the agent (app-level messages). */
  sendJSON: (data: Record<string, unknown>) => void;
  /** The last non-voice-protocol message received from the server. */
  lastCustomMessage: unknown;
}
/** Options accepted by useVoiceInput. */
interface UseVoiceInputOptions {
  /** Agent name (matches the server-side Durable Object class). */
  agent: string;
  /** Instance name for the agent. @default "default" */
  name?: string;
  /** Host to connect to. @default window.location.host */
  host?: string;
  /** RMS threshold below which audio is considered silence. @default 0.04 */
  silenceThreshold?: number;
  /** How long silence must last before sending end_of_speech (ms). @default 500 */
  silenceDurationMs?: number;
}
interface UseVoiceInputReturn {
  /** Accumulated final transcript text from all utterances. */
  transcript: string;
  /**
   * Current interim (partial) transcript from streaming STT.
   * Updates in real time as the user speaks. null when not available.
   */
  interimTranscript: string | null;
  /** Whether the mic is actively listening. */
  isListening: boolean;
  /** Current audio level (0–1) for visual feedback (e.g. waveform). */
  audioLevel: number;
  /** Whether the mic is muted. */
  isMuted: boolean;
  /** Any error message. */
  error: string | null;
  /** Start listening — requests mic permission and begins streaming audio. */
  start: () => Promise<void>;
  /** Stop listening — releases the mic. */
  stop: () => void;
  /** Toggle mute (mic stays open but audio is not sent). */
  toggleMute: () => void;
  /** Clear the accumulated transcript. */
  clear: () => void;
}
/**
 * React hook for voice-to-text input. Captures microphone audio, streams it
 * to a server-side VoiceAgent for STT, and returns the transcript as a string.
 *
 * Unlike `useVoiceAgent`, this hook is optimised for dictation — it accumulates
 * user transcripts into a single string and ignores assistant responses / TTS.
 *
 * @example
 * ```tsx
 * const { transcript, interimTranscript, isListening, start, stop } = useVoiceInput({
 *   agent: "voice-input-agent"
 * });
 *
 * <textarea value={transcript + (interimTranscript ? " " + interimTranscript : "")} />
 * <button onClick={isListening ? stop : start}>
 *   {isListening ? "Stop" : "Dictate"}
 * </button>
 * ```
 */
declare function useVoiceInput(
  options: UseVoiceInputOptions
): UseVoiceInputReturn;
/**
 * React hook that wraps VoiceClient, syncing its state into React state.
 * All audio infrastructure (mic capture, playback, silence/interrupt detection,
 * voice protocol) is handled by VoiceClient — this hook just bridges to React.
 *
 * When the connection identity changes (agent, name, or host), the hook
 * automatically disconnects the old client, creates a new one, and reconnects.
 * The `onReconnect` callback fires when this happens.
 */
declare function useVoiceAgent(
  options: UseVoiceAgentOptions
): UseVoiceAgentReturn;
//#endregion
export {
  SFUVoiceAudioInput,
  type SFUVoiceAudioInputOptions,
  type TranscriptMessage,
  UseVoiceAgentOptions,
  UseVoiceAgentReturn,
  UseVoiceInputOptions,
  UseVoiceInputReturn,
  type VoiceAudioFormat,
  type VoiceAudioInput,
  type VoiceClientEvent,
  type VoiceClientEventMap,
  type VoiceClientOptions,
  type VoicePipelineMetrics,
  type VoiceRole,
  type VoiceStatus,
  type VoiceTransport,
  WebSocketVoiceTransport,
  useVoiceAgent,
  useVoiceInput
};
//# sourceMappingURL=voice-react.d.ts.map

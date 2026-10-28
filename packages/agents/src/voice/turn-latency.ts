/**
 * Latency of one user→agent turn, measured the way production voice stacks do:
 * - anchored at the moment the user stopped speaking (Pipecat
 *   `UserBotLatencyObserver`: VAD stop minus its silence wait; LiveKit
 *   `stopped_speaking_at`) and ended when the agent's first audio goes out
 *   (Pipecat `BotStartedSpeakingFrame`; LiveKit `started_speaking_at`);
 * - every timestamp read from one clock, the agent's `Date.now()`;
 * - named after LiveKit's per-turn metrics (`e2e_latency`, `end_of_turn_delay`,
 *   `llm_node_ttft`, `tts_node_ttfb`), with Pipecat-style stages that add up to
 *   the total.
 */

/**
 * Normalized RMS a 16-bit PCM frame must reach to count as speech: the browser
 * client's default `silenceThreshold`.
 * ponytail: fixed threshold with no noise-floor tracking; a loud line can hold
 * "speaking" open and shorten the measured delays. Swap in a real VAD if that shows.
 */
export const SPEECH_RMS = 0.04;

/** Whether a 16-bit PCM frame is loud enough to be speech. */
export function isSpeech(pcm16: ArrayBuffer): boolean {
  const samples = new Int16Array(pcm16, 0, pcm16.byteLength >> 1);
  if (samples.length === 0) return false;
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / samples.length) / 32768 >= SPEECH_RMS;
}

/** The user's side of a turn. */
export type UserTurnEnd = {
  /** Last inbound frame loud enough to be speech; null when none was heard. */
  stoppedSpeakingAt: number | null;
  /** When speech recognition ended the turn (eager or final end of turn). */
  turnDetectedAt: number;
};

type Mark = "llmStart" | "llmFirstToken" | "ttsStart" | "firstAudio";

// Each stage runs from the previous point to the named one.
const STAGES: Array<[stage: string, point: keyof UserTurnEnd | Mark]> = [
  ["end_of_turn", "turnDetectedAt"],
  ["before_llm", "llmStart"],
  ["llm_ttft", "llmFirstToken"],
  ["sentence", "ttsStart"],
  ["tts_ttfb", "firstAudio"]
];

export type TurnLatencyReport = {
  /** User stopped speaking → first audio sent. Null without a speech anchor. */
  e2e_latency_ms: number | null;
  /** User stopped speaking → speech recognition ended the turn. */
  end_of_turn_delay_ms: number | null;
  /** onTurn called → first text from the model. */
  llm_ttft_ms: number | null;
  /** First text handed to TTS → first audio sent. */
  tts_ttfb_ms: number | null;
  /** Consecutive stages; they add up to the total from the first known point. */
  stages: Array<{ stage: string; ms: number }>;
};

export class TurnLatency {
  readonly #marks = new Map<Mark, number>();
  #reported = false;

  constructor(
    readonly signal: AbortSignal,
    readonly user: UserTurnEnd | null
  ) {}

  /** Records `name` the first time only. */
  mark(name: Mark, at = Date.now()): void {
    if (!this.#marks.has(name)) this.#marks.set(name, at);
  }

  /** Marks the first audio and returns the report, once per turn. */
  firstAudio(at = Date.now()): TurnLatencyReport | null {
    if (this.#reported) return null;
    this.#reported = true;
    this.mark("firstAudio", at);
    const point = (name: keyof UserTurnEnd | Mark): number | undefined =>
      name === "stoppedSpeakingAt" || name === "turnDetectedAt"
        ? (this.user?.[name] ?? undefined)
        : this.#marks.get(name);
    const between = (from: number | undefined, to: number | undefined) =>
      from === undefined || to === undefined ? null : Math.max(0, to - from);

    const stages: TurnLatencyReport["stages"] = [];
    let cursor = point("stoppedSpeakingAt");
    for (const [stage, name] of STAGES) {
      const at = point(name);
      if (at === undefined) continue;
      if (cursor !== undefined) {
        stages.push({ stage, ms: Math.max(0, at - cursor) });
      }
      cursor = Math.max(cursor ?? at, at);
    }
    return {
      e2e_latency_ms: between(point("stoppedSpeakingAt"), point("firstAudio")),
      end_of_turn_delay_ms: between(
        point("stoppedSpeakingAt"),
        point("turnDetectedAt")
      ),
      llm_ttft_ms: between(point("llmStart"), point("llmFirstToken")),
      tts_ttfb_ms: between(point("ttsStart"), point("firstAudio")),
      stages
    };
  }
}

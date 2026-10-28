import { describe, expect, it } from "vitest";
import { isSpeech, TurnLatency } from "../turn-latency";

const signal = new AbortController().signal;

describe("TurnLatency", () => {
  it("anchors at the end of speech and splits the wait into stages that add up", () => {
    const turn = new TurnLatency(signal, {
      stoppedSpeakingAt: 1000,
      turnDetectedAt: 1400
    });
    turn.mark("llmStart", 1450);
    turn.mark("llmFirstToken", 2250);
    turn.mark("llmFirstToken", 9999);
    turn.mark("ttsStart", 2400);
    const report = turn.firstAudio(3000);

    expect(report).toEqual({
      e2e_latency_ms: 2000,
      end_of_turn_delay_ms: 400,
      llm_ttft_ms: 800,
      tts_ttfb_ms: 600,
      stages: [
        { stage: "end_of_turn", ms: 400 },
        { stage: "before_llm", ms: 50 },
        { stage: "llm_ttft", ms: 800 },
        { stage: "sentence", ms: 150 },
        { stage: "tts_ttfb", ms: 600 }
      ]
    });
    expect(report?.stages.reduce((sum, { ms }) => sum + ms, 0)).toBe(2000);
    expect(turn.firstAudio(4000)).toBeNull();
  });

  it("keeps stages adding up when the model starts before the turn ends (eager)", () => {
    const turn = new TurnLatency(signal, {
      stoppedSpeakingAt: 1000,
      turnDetectedAt: 1300
    });
    turn.mark("llmStart", 1200);
    turn.mark("llmFirstToken", 1900);
    turn.mark("ttsStart", 1900);
    const report = turn.firstAudio(2500);

    expect(report?.e2e_latency_ms).toBe(1500);
    expect(report?.stages.reduce((sum, { ms }) => sum + ms, 0)).toBe(1500);
  });

  it("reports no end-to-end latency without a speech anchor", () => {
    const turn = new TurnLatency(signal, null);
    turn.mark("llmStart", 100);
    turn.mark("llmFirstToken", 600);
    turn.mark("ttsStart", 600);
    const report = turn.firstAudio(900);

    expect(report?.e2e_latency_ms).toBeNull();
    expect(report?.end_of_turn_delay_ms).toBeNull();
    expect(report?.llm_ttft_ms).toBe(500);
    expect(report?.stages).toEqual([
      { stage: "llm_ttft", ms: 500 },
      { stage: "sentence", ms: 0 },
      { stage: "tts_ttfb", ms: 300 }
    ]);
  });
});

describe("isSpeech", () => {
  it("separates speech-level PCM from line noise", () => {
    expect(isSpeech(new Int16Array(320).fill(3000).buffer)).toBe(true);
    expect(isSpeech(new Int16Array(320).fill(200).buffer)).toBe(false);
    expect(isSpeech(new ArrayBuffer(0))).toBe(false);
  });
});

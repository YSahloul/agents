import { describe, expect, it } from "vitest";
import { PlaybackTimeline } from "../voice-interruption";

// mulaw at 8000 Hz: 8 bytes = 1 ms.
function mulaw(): PlaybackTimeline {
  const timeline = PlaybackTimeline.forFormat("mulaw", 8000);
  if (!timeline) throw new Error("expected a timeline");
  return timeline;
}

describe("PlaybackTimeline", () => {
  it("keeps whole played sentences plus whole words of the current one", () => {
    const timeline = mulaw();
    timeline.begin("One two three.");
    timeline.add(8000, 0);
    timeline.end();
    timeline.begin("Four five six.");
    timeline.add(8000, 0);
    timeline.end();

    expect(timeline.heardText(0)).toBe("");
    expect(timeline.heardText(1500)).toBe("One two three. Four");
    expect(timeline.heardText(2500)).toBe("One two three. Four five six.");
    expect(timeline.isPlaying(1999)).toBe(true);
    expect(timeline.isPlaying(2000)).toBe(false);
  });

  it("counts a gap in the audio as unplayed time", () => {
    const timeline = mulaw();
    timeline.begin("Alpha beta gamma delta.");
    timeline.add(4000, 0);
    timeline.add(4000, 1000);
    timeline.end();

    expect(timeline.heardText(1250)).toBe("Alpha beta gamma");
  });

  it("ignores a sentence whose audio never finished arriving", () => {
    const timeline = mulaw();
    timeline.begin("Never finished.");
    timeline.add(8000, 0);

    expect(timeline.heardText(5000)).toBe("");
  });

  it("counts word-timed chunks only once fully played", () => {
    const timeline = mulaw();
    timeline.add(4000, 0, "Hello ");
    timeline.add(4000, 0, "there.");

    expect(timeline.heardText(600)).toBe("Hello");
    expect(timeline.heardText(1000)).toBe("Hello there.");
  });

  it("measures pcm16 and rejects encoded formats", () => {
    expect(PlaybackTimeline.forFormat("mp3", 16000)).toBeNull();
    const timeline = PlaybackTimeline.forFormat("pcm16", 16000);
    timeline?.begin("x y");
    timeline?.add(32000, 0);
    timeline?.end();

    expect(timeline?.isPlaying(999)).toBe(true);
    expect(timeline?.isPlaying(1000)).toBe(false);
  });
});

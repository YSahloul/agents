import { env } from "cloudflare:workers";
import { getServerByName } from "partyserver";
import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import type { ThinkVoiceTestAgent } from "./agents";

async function freshAgent(name: string) {
  return getServerByName(
    env.ThinkVoiceTestAgent as unknown as DurableObjectNamespace<ThinkVoiceTestAgent>,
    name
  );
}

function textOf(message: UIMessage | undefined): string {
  return (message?.parts ?? [])
    .filter(
      (part): part is { type: "text"; text: string } => part.type === "text"
    )
    .map((part) => part.text)
    .join("");
}

describe("Think voice adapter", () => {
  it("routes a voice channel turn through Think Session", async () => {
    const agent = await freshAgent(`voice-${crypto.randomUUID()}`);
    await agent.runVoiceTurnForTest("hello");

    const messages = (await agent.getStoredMessages()) as UIMessage[];
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant"
    ]);
    expect(textOf(messages[0])).toBe("hello");
    expect(textOf(messages[1])).toBe("voice answer");
    expect((messages[0].metadata as { channel?: string }).channel).toBe(
      "voice"
    );
    expect(await agent.getVoiceSqlTables()).toEqual([]);
  });

  it("stamps connection metadata once for an inherited voice turn", async () => {
    const agent = await freshAgent(`voice-metadata-${crypto.randomUUID()}`);
    const uri = "https://example.com/voice?llm=%40cf%2Ftest";

    await agent.runVoiceOnTurnForTest("metadata input", uri);

    const messages = (await agent.getStoredMessages()) as UIMessage[];
    const user = messages.find((message) => message.role === "user");
    const metadata = user?.metadata as
      | { turnMetadata?: Record<string, unknown> }
      | undefined;
    expect(metadata?.turnMetadata).toEqual({
      transcript: "metadata input",
      uri
    });
    expect(await agent.getVoiceMetadataCallsForTest()).toBe(1);
  });

  it("keeps successful textless voice turns silent", async () => {
    const agent = await freshAgent(`voice-textless-${crypto.randomUUID()}`);
    await agent.setVoiceResponseForTest("");

    await expect(
      agent.runVoiceOnTurnForTest(
        "dispatch a tool",
        "https://example.com/voice"
      )
    ).resolves.toBe("");
  });

  it("uses Think Session as the sole persisted voice transcript", async () => {
    const agent = await freshAgent(`voice-persistence-${crypto.randomUUID()}`);
    await agent.runVoiceTurnForTest("first");
    await agent.runVoiceTurnForTest("second");

    const messages = (await agent.getStoredMessages()) as UIMessage[];
    expect(messages.filter((message) => message.role === "user")).toHaveLength(
      2
    );
    expect(await agent.getVoiceSqlTables()).toEqual([]);
  });
  it("persists only marked speech before admitting the continuation", async () => {
    const agent = await freshAgent(`voice-interrupt-${crypto.randomUUID()}`);
    await agent.setVoiceResponseForTest("First sentence. Discarded ending.");
    await agent.runMarkedVoiceTurnForTest("tell me a story");
    await expect(agent.drainOnePlaybackMarkerForTest()).resolves.toBe(
      "First sentence."
    );
    await agent.interruptMarkedVoiceTurnForTest();

    let messages = (await agent.getStoredMessages()) as UIMessage[];
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant"
    ]);
    expect(textOf(messages[1])).toBe("First sentence.");

    await agent.setVoiceResponseForTest("Continuation answer.");
    await agent.runMarkedVoiceTurnForTest("continue");
    messages = (await agent.getStoredMessages()) as UIMessage[];
    expect(textOf(messages[1])).toBe("First sentence.");
    const nextPrompt = await agent.getLastModelPromptForTest();
    expect(nextPrompt).toContain("First sentence.");
    expect(nextPrompt).not.toContain("Discarded ending.");
  });

  it("deletes an interrupted text-only assistant with no playback mark", async () => {
    const agent = await freshAgent(`voice-zero-marker-${crypto.randomUUID()}`);
    await agent.setVoiceResponseForTest("Nothing reached playback.");
    await agent.runMarkedVoiceTurnForTest("start");
    await agent.interruptMarkedVoiceTurnForTest();

    const messages = (await agent.getStoredMessages()) as UIMessage[];
    expect(messages.map((message) => message.role)).toEqual(["user"]);
  });
});

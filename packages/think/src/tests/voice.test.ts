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
});

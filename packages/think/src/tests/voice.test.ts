import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import type { ThinkVoiceTestAgent } from "./agents";

async function freshAgent(name: string) {
  return getAgentByName(
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

type EagerResult = {
  pending: UIMessage[];
  stored: UIMessage[];
  modelCalls: number;
  pendingToolExecutions: number;
  toolExecutions: number;
  text: string;
};

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
  it("starts inference but never commits a rejected eager turn", async () => {
    const agent = await freshAgent(`voice-eager-abort-${crypto.randomUUID()}`);
    await agent.runVoiceTurnForTest("previous confirmed turn");
    const before = (await agent.getStoredMessages()) as UIMessage[];
    const result = JSON.parse(
      await agent.runEagerVoiceTurnForTest(
        "discarded eager transcript",
        false,
        true
      )
    ) as EagerResult;
    expect(result.modelCalls).toBeGreaterThan(0);
    expect(result.pending).toEqual(before);
    expect(result.stored).toEqual(before);
    expect(result.pendingToolExecutions).toBe(0);
    expect(result.toolExecutions).toBe(0);
    expect(result.text).toBe("");
  });

  it("commits a confirmed eager turn once and executes its tool", async () => {
    const agent = await freshAgent(
      `voice-eager-confirm-${crypto.randomUUID()}`
    );
    const result = JSON.parse(
      await agent.runEagerVoiceTurnForTest(
        "confirmed eager transcript",
        true,
        true
      )
    ) as EagerResult;
    expect(result.pending).toEqual([]);
    expect(result.pendingToolExecutions).toBe(0);
    expect(result.stored.map((message) => message.role)).toEqual([
      "user",
      "assistant"
    ]);
    expect(textOf(result.stored[0])).toBe("confirmed eager transcript");
    expect(result.toolExecutions).toBe(1);
    expect(result.text).toBe("voice answer");
  });
  it.each([
    { mode: "ordinary", eager: false, spokenText: "" },
    { mode: "confirmed eager", eager: true, spokenText: "" },
    { mode: "partially spoken", eager: false, spokenText: "voice" },
    { mode: "unacknowledged", eager: false, spokenText: undefined },
    { mode: "unacknowledged eager", eager: true, spokenText: undefined }
  ])(
    "keeps a $mode tool result after speech interrupts its voice output",
    async ({ eager, spokenText }) => {
      const agent = await freshAgent(`voice-tool-${crypto.randomUUID()}`);
      const result = JSON.parse(
        await agent.runInterruptedToolVoiceTurnForTest(eager, spokenText)
      ) as {
        stored: UIMessage[];
        toolExecutions: number;
        outputDiscarded: boolean;
      };

      expect(result.toolExecutions).toBe(1);
      expect(result.outputDiscarded).toBe(true);
      expect(result.stored.map((message) => message.role)).toEqual([
        "user",
        "assistant"
      ]);
      expect(result.stored[1].parts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "tool-record",
            state: "output-available",
            output: "recorded"
          })
        ])
      );
      expect(textOf(result.stored[1])).toBe(spokenText ?? "");
    }
  );

  it("replaces an interrupted assistant response with acknowledged speech", async () => {
    const agent = await freshAgent(`voice-interrupted-${crypto.randomUUID()}`);

    const { stored: messages } = JSON.parse(
      await agent.reconcileInterruptedVoiceTurnForTest("voice")
    ) as { stored: UIMessage[] };
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant"
    ]);
    expect(textOf(messages[0])).toBe("interrupted question");
    expect(textOf(messages[1])).toBe("voice");
    expect(messages[1].metadata).toMatchObject({ interrupted: true });
  });

  it.each([false, true])(
    "excludes an unacknowledged interrupted reply from the next model request (eager: %s)",
    async (eager) => {
      const agent = await freshAgent(`voice-unheard-${crypto.randomUUID()}`);
      const result = JSON.parse(
        await agent.reconcileInterruptedVoiceTurnForTest(undefined, eager)
      ) as { stored: UIMessage[]; nextPrompt: unknown };

      expect(result.stored.map((message) => message.role)).toEqual(["user"]);
      expect(textOf(result.stored[0])).toBe("interrupted question");
      expect(JSON.stringify(result.nextPrompt)).not.toContain("voice answer");
      expect(JSON.stringify(result.nextPrompt)).toContain(
        "interrupted question"
      );
      expect(JSON.stringify(result.nextPrompt)).toContain("follow up");
    }
  );

  it("does not erase a completed reply on an idle interrupt", async () => {
    const agent = await freshAgent(`voice-idle-${crypto.randomUUID()}`);
    const result = JSON.parse(await agent.runIdleVoiceInterruptForTest()) as {
      before: UIMessage[];
      after: UIMessage[];
    };
    expect(textOf(result.before[1])).toBe("voice answer");
    expect(result.after).toEqual(result.before);
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
});

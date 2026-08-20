import { env } from "cloudflare:workers";
import { getServerByName } from "partyserver";
import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import type { ThinkNoticeSurfaceTestAgent, ThinkTestAgent } from "./agents";
async function freshAgent(name: string) {
  return getServerByName(
    env.ThinkTestAgent as unknown as DurableObjectNamespace<ThinkTestAgent>,
    name
  );
}

async function freshCustomAgent(name: string) {
  return getServerByName(
    env.ThinkNoticeSurfaceTestAgent as unknown as DurableObjectNamespace<ThinkNoticeSurfaceTestAgent>,
    name
  );
}
function lastMessage(messages: UIMessage[]): UIMessage | undefined {
  return messages[messages.length - 1];
}

function textOf(message: UIMessage | undefined): string {
  return (message?.parts ?? [])
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
}

describe("deliverNotice", () => {
  it("appends a plain web notice to the transcript when informModel is false", async () => {
    const agent = await freshAgent("notice-web-plain");
    await agent.deliverNotice("background job started");
    const messages = (await agent.getStoredMessages()) as UIMessage[];
    const last = lastMessage(messages);
    expect(last?.role).toBe("assistant");
    expect(textOf(last)).toBe("background job started");
  });

  it("annotates the web notice when informModel is true", async () => {
    const agent = await freshAgent("notice-web-inform");
    await agent.deliverNotice("started a background agent", {
      informModel: true
    });
    const messages = (await agent.getStoredMessages()) as UIMessage[];
    expect(textOf(lastMessage(messages))).toBe(
      "[Delivered to the user out of band] started a background agent"
    );
  });

  it("accepts a markdown payload", async () => {
    const agent = await freshAgent("notice-web-markdown");
    await agent.deliverNotice({ markdown: "**done**" });
    const messages = (await agent.getStoredMessages()) as UIMessage[];
    expect(textOf(lastMessage(messages))).toBe("**done**");
  });

  it("records the delivery kind on the notice message metadata", async () => {
    const agent = await freshAgent("notice-web-kind");
    await agent.deliverNotice("typing…", { kind: "command" });
    const messages = (await agent.getStoredMessages()) as UIMessage[];
    const last = lastMessage(messages) as
      | (UIMessage & { metadata?: { deliveryKind?: string } })
      | undefined;
    expect(last?.metadata?.deliveryKind).toBe("command");
  });

  it("defaults the delivery kind to notice", async () => {
    const agent = await freshAgent("notice-web-default-kind");
    await agent.deliverNotice("fyi");
    const messages = (await agent.getStoredMessages()) as UIMessage[];
    const last = lastMessage(messages) as
      | (UIMessage & { metadata?: { deliveryKind?: string } })
      | undefined;
    expect(last?.metadata?.deliveryKind).toBe("notice");
  });

  it("does not start a model turn (notices are assistant-only, no user turn)", async () => {
    const agent = await freshAgent("notice-no-turn");
    await agent.deliverNotice("note one");
    await agent.deliverNotice("note two");
    const messages = (await agent.getStoredMessages()) as UIMessage[];
    expect(messages).toHaveLength(2);
    expect(messages.every((m) => m.role === "assistant")).toBe(true);
  });

  it("uses a non-messenger delivery hook without opening a turn", async () => {
    const agent = await freshCustomAgent("notice-custom");
    await agent.deliverCustomNotice("custom notice");
    expect(await agent.getNotices()).toEqual(["custom notice"]);
  });

  it("preserves the missing-surface error for a named custom channel", async () => {
    const agent = await freshCustomAgent("notice-custom-missing");
    const error = await agent.deliverNoticeErrorForTest("hi", "missing");
    expect(error).toMatch(/channel "missing" is not registered/);
  });
});

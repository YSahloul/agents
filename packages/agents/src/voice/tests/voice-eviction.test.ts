/**
 * Forced Durable Object eviction coverage for ephemeral VoiceAgent history.
 *
 * Conversation history is process-local: active calls retain ordered context,
 * while actor reconstruction starts with an empty history.
 */
import { env } from "cloudflare:workers";
import {
  evictAllDurableObjects,
  evictDurableObject,
  runInDurableObject
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { TestPersistentVoiceAgent, TestVoiceAgent } from "./agents/voice";

type History = Array<{ role: string; content: string }>;

function voiceStub(name: string) {
  return env.TestVoiceAgent.get(
    env.TestVoiceAgent.idFromName(name)
  ) as DurableObjectStub<TestVoiceAgent>;
}

function persistentVoiceStub(name: string) {
  return env.TestPersistentVoiceAgent.get(
    env.TestPersistentVoiceAgent.idFromName(name)
  ) as DurableObjectStub<TestPersistentVoiceAgent>;
}

async function appendTurns<T extends TestPersistentVoiceAgent | TestVoiceAgent>(
  stub: DurableObjectStub<T>,
  turns: Array<{ user: string; assistant: string }>
): Promise<void> {
  await runInDurableObject(stub, (instance) => {
    for (const turn of turns) {
      instance.saveMessage("user", turn.user);
      instance.saveMessage("assistant", turn.assistant);
    }
  });
}

async function readHistory<T extends TestPersistentVoiceAgent | TestVoiceAgent>(
  stub: DurableObjectStub<T>
): Promise<History> {
  return runInDurableObject(stub, (instance) =>
    instance.getConversationHistory()
  );
}

describe("VoiceAgent history after forced Durable Object eviction", () => {
  it("starts fresh after eviction and accepts new turns", async () => {
    const stub = voiceStub(`evict-voice-${crypto.randomUUID()}`);
    await appendTurns(stub, [
      { user: "what's the weather?", assistant: "Sunny" },
      { user: "and tomorrow?", assistant: "Rain" }
    ]);

    expect(await readHistory(stub)).toEqual([
      { role: "user", content: "what's the weather?" },
      { role: "assistant", content: "Sunny" },
      { role: "user", content: "and tomorrow?" },
      { role: "assistant", content: "Rain" }
    ]);

    await evictDurableObject(stub);
    expect(await readHistory(stub)).toEqual([]);

    await appendTurns(stub, [{ user: "weekend?", assistant: "Clear" }]);
    expect(await readHistory(stub)).toEqual([
      { role: "user", content: "weekend?" },
      { role: "assistant", content: "Clear" }
    ]);
  });

  it("clears every named transcript after a global forced eviction", async () => {
    const stubA = voiceStub(`evict-voice-a-${crypto.randomUUID()}`);
    const stubB = voiceStub(`evict-voice-b-${crypto.randomUUID()}`);
    await appendTurns(stubA, [{ user: "A", assistant: "A reply" }]);
    await appendTurns(stubB, [{ user: "B", assistant: "B reply" }]);

    expect(await readHistory(stubA)).toHaveLength(2);
    expect(await readHistory(stubB)).toHaveLength(2);

    await evictAllDurableObjects();

    expect(await readHistory(stubA)).toEqual([]);
    expect(await readHistory(stubB)).toEqual([]);
  });
});

describe("VoiceAgent durable history after forced Durable Object eviction", () => {
  it("restores and extends the exact ordered transcript", async () => {
    const stub = persistentVoiceStub(
      `evict-persistent-voice-${crypto.randomUUID()}`
    );
    await appendTurns(stub, [
      { user: "what's the weather?", assistant: "Sunny" },
      { user: "and tomorrow?", assistant: "Rain" }
    ]);

    await evictDurableObject(stub);

    expect(await readHistory(stub)).toEqual([
      { role: "user", content: "what's the weather?" },
      { role: "assistant", content: "Sunny" },
      { role: "user", content: "and tomorrow?" },
      { role: "assistant", content: "Rain" }
    ]);

    await appendTurns(stub, [{ user: "weekend?", assistant: "Clear" }]);
    expect(await readHistory(stub)).toEqual([
      { role: "user", content: "what's the weather?" },
      { role: "assistant", content: "Sunny" },
      { role: "user", content: "and tomorrow?" },
      { role: "assistant", content: "Rain" },
      { role: "user", content: "weekend?" },
      { role: "assistant", content: "Clear" }
    ]);
  });

  it("keeps named transcripts isolated after a global forced eviction", async () => {
    const stubA = persistentVoiceStub(
      `evict-persistent-voice-a-${crypto.randomUUID()}`
    );
    const stubB = persistentVoiceStub(
      `evict-persistent-voice-b-${crypto.randomUUID()}`
    );
    await appendTurns(stubA, [{ user: "A", assistant: "A reply" }]);
    await appendTurns(stubB, [{ user: "B", assistant: "B reply" }]);

    await evictAllDurableObjects();

    expect(await readHistory(stubA)).toEqual([
      { role: "user", content: "A" },
      { role: "assistant", content: "A reply" }
    ]);
    expect(await readHistory(stubB)).toEqual([
      { role: "user", content: "B" },
      { role: "assistant", content: "B reply" }
    ]);
  });
});

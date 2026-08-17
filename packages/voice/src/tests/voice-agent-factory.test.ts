import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { Connection } from "agents";
import { describe, expect, it } from "vitest";
import type { TestVoiceAgentFactory } from "./agents/voice-agent-factory";

function factoryStub(name = crypto.randomUUID()) {
  return env.TestVoiceAgentFactory.get(
    env.TestVoiceAgentFactory.idFromName(name)
  ) as DurableObjectStub<TestVoiceAgentFactory>;
}

describe("createVoiceAgent", () => {
  it("constructs transcriber/tts from config and tracks call props + greeting", async () => {
    const stub = factoryStub();

    const providerNames = await runInDurableObject(stub, async (instance) => [
      instance.transcriber?.constructor.name,
      instance.tts?.constructor.name
    ]);
    expect(providerNames).toEqual(["StubTranscriber", "StubTTS"]);

    await runInDurableObject(stub, async (instance) => {
      await instance.onStart({ foo: "bar" });
    });
    const callProps = await runInDurableObject(
      stub,
      async (instance) => instance.callProps
    );
    expect(callProps).toEqual({ foo: "bar" });

    await runInDurableObject(stub, async (instance) => {
      const connection = { id: "conn-1", send() {} } as unknown as Connection;
      await instance.onCallStart(connection);
    });
    const speakCalls = await runInDurableObject(
      stub,
      async (instance) => instance.speakCalls
    );
    expect(speakCalls).toEqual([{ connectionId: "conn-1", text: "hi there" }]);
  });
});

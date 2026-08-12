import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  TestMissingSFUConfigAgent,
  TestSFUVoiceAgent
} from "./agents/sfu-voice";

function sfuStub(name = crypto.randomUUID()) {
  return env.TestSFUVoiceAgent.get(
    env.TestSFUVoiceAgent.idFromName(name)
  ) as DurableObjectStub<TestSFUVoiceAgent>;
}

function missingConfigStub(name = crypto.randomUUID()) {
  return env.TestMissingSFUConfigAgent.get(
    env.TestMissingSFUConfigAgent.idFromName(name)
  ) as DurableObjectStub<TestMissingSFUConfigAgent>;
}

function post(path: string, body?: unknown): Request {
  return new Request(`https://example.com/agents/voice/alice${path}`, {
    method: "POST",
    headers:
      body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("withSFUVoice", () => {
  it("lazily intercepts only the two WebSocket and six HTTP routes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("SFU unavailable")))
    );
    const stub = sfuStub();

    const initial = await runInDurableObject(stub, async (instance) => {
      const http = await instance.onRequest(
        new Request("https://example.com/other")
      );
      const fetchResponse = await instance.fetch(
        new Request("https://example.com/other")
      );
      const unmatchedUpgrade = await instance.fetch(
        new Request("https://example.com/voice/other", {
          headers: { Upgrade: "websocket" }
        })
      );
      return {
        configCalls: instance.configCalls,
        onRequestCalls: instance.onRequestCalls,
        fetchCalls: instance.fetchCalls,
        bodies: [
          await http.text(),
          await fetchResponse.text(),
          await unmatchedUpgrade.text()
        ]
      };
    });
    expect(initial).toEqual({
      configCalls: 0,
      onRequestCalls: 1,
      fetchCalls: 2,
      bodies: ["consumer request", "consumer fetch", "consumer fetch"]
    });

    const callbackStatuses = await runInDurableObject(
      stub,
      async (instance) => {
        const statuses: number[] = [];
        for (const path of [
          "/voice/tts/subscribe",
          "/voice/stt/sfu-subscribe"
        ]) {
          const response = await instance.fetch(
            new Request(`https://example.com${path}`, {
              headers: { Upgrade: "websocket" }
            })
          );
          statuses.push(response.status);
          response.webSocket?.accept();
          response.webSocket?.close();
        }
        return statuses;
      }
    );
    expect(callbackStatuses).toEqual([101, 101]);

    const requests = [
      post("/voice/tts/publish"),
      post("/voice/rtc/connect", {}),
      post("/voice/rtc/pull"),
      post("/voice/rtc/renegotiate", {}),
      post("/voice/stt/start-forwarding"),
      post("/voice/stt/stop-forwarding")
    ];
    const statuses = await runInDurableObject(stub, async (instance) => {
      const result: number[] = [];
      for (const request of requests) {
        result.push((await instance.onRequest(request)).status);
      }
      expect(instance.onRequestCalls).toBe(1);
      expect(instance.configCalls).toBe(1);
      return result;
    });
    expect(statuses).toEqual([500, 400, 400, 400, 400, 200]);
  });

  it("persists and deletes transport state under cf_voice_sfu_state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/adapters/websocket/new")) {
          return Response.json({
            tracks: [
              {
                sessionId: "tts-session",
                adapterId: "tts-adapter"
              }
            ]
          });
        }
        if (init?.method === "DELETE") return Response.json({});
        return new Response("unexpected SFU request", { status: 500 });
      })
    );
    const stub = sfuStub();

    const result = await runInDurableObject(stub, async (instance) => {
      const upgrade = await instance.fetch(
        new Request(
          "https://example.com/agents/voice/alice/voice/tts/subscribe",
          {
            headers: { Upgrade: "websocket" }
          }
        )
      );
      const callback = upgrade.webSocket!;
      callback.accept();

      const publish = await instance.onRequest(post("/voice/tts/publish"));
      const stored = await instance.getStoredSFUStateForTest();
      const transport = await instance.createAudioTransport(null as never);
      if (!transport) throw new Error("Expected SFU transport");
      await transport.start("connection", () => {});
      await transport.stop("connection");
      return {
        publishStatus: publish.status,
        stored,
        deleted: await instance.getStoredSFUStateForTest()
      };
    });

    expect(result.publishStatus).toBe(200);
    expect(result.stored?.tts).toMatchObject({
      sessionId: "tts-session",
      adapterId: "tts-adapter"
    });
    expect(result.deleted).toBeNull();
  });

  it("reports the exact missing-config error without writing state", async () => {
    const stub = missingConfigStub();
    await expect(
      runInDurableObject(stub, (instance) =>
        instance.onRequest(post("/voice/rtc/connect", {}))
      )
    ).rejects.toThrow("SFU voice agent must implement getSFUConfig()");
    await expect(
      runInDurableObject(stub, (instance) =>
        instance.getStoredSFUStateForTest()
      )
    ).resolves.toBeNull();
  });
});

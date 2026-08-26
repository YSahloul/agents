import { beforeAll, describe, expect, it } from "vitest";
import { TwilioAdapter } from "../src/index.js";

type Handler = (event: { data?: unknown }) => void;

class FakeWebSocket {
  readyState = 1;
  sent: unknown[] = [];
  closeCode?: number;
  closeReason?: string;
  private handlers = new Map<string, Handler[]>();

  accept() {}

  send(data: unknown) {
    this.sent.push(data);
  }

  close(code?: number, reason?: string) {
    this.closeCode = code;
    this.closeReason = reason;
    this.readyState = 3;
  }

  addEventListener(event: string, handler: Handler) {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
  }

  emit(event: string, payload?: { data?: unknown }) {
    for (const handler of this.handlers.get(event) ?? [])
      handler(payload ?? {});
  }

  get jsonSent(): Record<string, unknown>[] {
    return this.sent
      .filter((data): data is string => typeof data === "string")
      .map((data) => JSON.parse(data) as Record<string, unknown>);
  }
}

let lastPair: { twilio: FakeWebSocket; server: FakeWebSocket } | null = null;

beforeAll(() => {
  (globalThis as unknown as Record<string, unknown>)["WebSocketPair"] =
    function (this: Record<number, FakeWebSocket>) {
      this[0] = new FakeWebSocket();
      this[1] = new FakeWebSocket();
      lastPair = { twilio: this[0], server: this[1] };
    };

  const OriginalResponse = globalThis.Response;
  (globalThis as unknown as Record<string, unknown>)["Response"] =
    class extends OriginalResponse {
      constructor(body?: BodyInit | null, init?: ResponseInit) {
        super(body, init?.status === 101 ? { ...init, status: 200 } : init);
      }
    };
});

interface Harness {
  serverSocket: FakeWebSocket;
  agentSocket: FakeWebSocket;
}

function createHarness(): Harness {
  const agentSocket = new FakeWebSocket();
  const env = {
    MyAgent: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: async () => ({ webSocket: agentSocket }) })
    }
  };
  TwilioAdapter.handleRequest(
    new Request("https://example.com/twilio", {
      headers: { Upgrade: "websocket" }
    }),
    env,
    "MyAgent"
  );
  if (!lastPair) throw new Error("WebSocketPair was not constructed");
  return { serverSocket: lastPair.server, agentSocket };
}

async function startCall(harness: Harness) {
  harness.serverSocket.emit("message", {
    data: JSON.stringify({
      event: "start",
      streamSid: "stream-1",
      start: {
        streamSid: "stream-1",
        callSid: "call-1",
        accountSid: "account-1",
        tracks: ["inbound"],
        customParameters: {},
        mediaFormat: {
          encoding: "audio/x-mulaw",
          sampleRate: 8000,
          channels: 1
        }
      }
    })
  });
  await Promise.resolve();
}

function mediaPayload(harness: Harness): Uint8Array | undefined {
  const message = harness.serverSocket.jsonSent.find(
    (candidate) => candidate.event === "media"
  );
  if (!message || !("media" in message)) return undefined;
  const media = message.media;
  if (!media || typeof media !== "object" || !("payload" in media)) {
    return undefined;
  }
  const payload = media.payload;
  if (typeof payload !== "string") return undefined;
  return Uint8Array.from(atob(payload), (character) => character.charCodeAt(0));
}

describe("TwilioAdapter outbound audio", () => {
  it.each([
    [16000, 320, 80],
    [24000, 480, 80]
  ])(
    "converts declared PCM16/%i into the Twilio media envelope",
    async (sampleRate, byteLength, outputLength) => {
      const harness = createHarness();
      await startCall(harness);
      harness.agentSocket.emit("message", {
        data: JSON.stringify({
          type: "audio_config",
          format: "pcm16",
          sampleRate
        })
      });
      harness.agentSocket.emit("message", {
        data: new ArrayBuffer(byteLength)
      });

      expect(mediaPayload(harness)).toHaveLength(outputLength);
      const media = harness.serverSocket.jsonSent.find(
        (message) => message.event === "media"
      );
      expect(media).toMatchObject({ event: "media", streamSid: "stream-1" });
    }
  );

  it("forwards declared mulaw/8 kHz bytes unchanged", async () => {
    const harness = createHarness();
    await startCall(harness);
    const mulaw = new Uint8Array([0, 1, 127, 255]);
    harness.agentSocket.emit("message", {
      data: JSON.stringify({
        type: "audio_config",
        format: "mulaw",
        sampleRate: 8000
      })
    });
    harness.agentSocket.emit("message", { data: mulaw.buffer });

    expect(mediaPayload(harness)).toEqual(mulaw);
  });

  it.each([
    ["mp3", undefined],
    ["mulaw", 16000]
  ])("rejects unsupported %s/%s audio", async (format, sampleRate) => {
    const harness = createHarness();
    await startCall(harness);
    harness.agentSocket.emit("message", {
      data: JSON.stringify({ type: "audio_config", format, sampleRate })
    });
    harness.agentSocket.emit("message", { data: new ArrayBuffer(320) });

    expect(mediaPayload(harness)).toBeUndefined();
    expect(harness.agentSocket.closeCode).toBe(1003);
    expect(harness.serverSocket.closeCode).toBe(1003);
    expect(harness.serverSocket.closeReason).toBe(
      "Unsupported agent audio format"
    );
  });

  it("keeps legacy PCM16/16 kHz behavior before audio_config", async () => {
    const harness = createHarness();
    await startCall(harness);
    harness.agentSocket.emit("message", { data: new ArrayBuffer(320) });

    expect(mediaPayload(harness)).toHaveLength(80);
  });
});

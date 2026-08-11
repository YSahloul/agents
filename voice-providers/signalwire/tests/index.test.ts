import { beforeAll, describe, expect, it } from "vitest";
import { SignalWireAdapter } from "../src/index.js";

type Handler = (event: MessageEvent) => void;

/** Independent G.711 μ-law encoder, written from the spec rather than reused
 * from the adapter, so the round-trip test cannot pass by sharing a bug. */
function encodeMulawReference(sample: number): number {
  const BIAS = 0x84;
  const CLIP = 32635;
  const sign = sample < 0 ? 0x80 : 0;
  const magnitude = Math.min(Math.abs(sample), CLIP) + BIAS;
  let exponent = 7;
  for (
    let mask = 0x4000;
    (magnitude & mask) === 0 && exponent > 0;
    mask >>= 1
  ) {
    exponent--;
  }
  const mantissa = (magnitude >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

class FakeWebSocket {
  readyState: number = WebSocket.OPEN;
  sent: unknown[] = [];
  closed = false;
  private handlers = new Map<string, Handler[]>();

  accept() {}
  send(data: unknown) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    this.readyState = WebSocket.CLOSED;
  }
  addEventListener(type: string, handler: Handler) {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), handler]);
  }
  emit(type: string, data?: unknown) {
    for (const handler of this.handlers.get(type) ?? []) {
      handler({ data } as MessageEvent);
    }
  }
  get json() {
    return this.sent
      .filter((value): value is string => typeof value === "string")
      .map((value) => JSON.parse(value) as Record<string, unknown>);
  }
}

let carrierSocket: FakeWebSocket;
let agentSocket: FakeWebSocket;
let instanceNames: string[];
let fetchedRequests: Request[];

beforeAll(() => {
  Object.defineProperty(globalThis, "WebSocketPair", {
    configurable: true,
    value: function (this: Record<number, FakeWebSocket>) {
      this[0] = new FakeWebSocket();
      this[1] = new FakeWebSocket();
      carrierSocket = this[1];
    }
  });

  const OriginalResponse = Response;
  Object.defineProperty(globalThis, "Response", {
    configurable: true,
    value: class extends OriginalResponse {
      constructor(
        body?: BodyInit | null,
        init?: ResponseInit & { webSocket?: FakeWebSocket }
      ) {
        super(body, init?.status === 101 ? { ...init, status: 200 } : init);
        Object.defineProperty(this, "webSocket", {
          value: init?.webSocket ?? null
        });
      }
    }
  });
});

function createAdapter(options?: {
  instanceName?: string;
  agentAudioFormat?: "mulaw" | "pcm16";
  sttSampleRate?: number;
}) {
  agentSocket = new FakeWebSocket();
  instanceNames = [];
  fetchedRequests = [];
  const env = {
    MyAgent: {
      idFromName(name: string) {
        instanceNames.push(name);
        return name;
      },
      get() {
        return {
          fetch: async (request: Request) => {
            fetchedRequests.push(request);
            return { webSocket: agentSocket };
          }
        };
      }
    }
  };
  SignalWireAdapter.handleRequest(
    new Request("https://example.com/signalwire", {
      headers: { Upgrade: "websocket" }
    }),
    env,
    "MyAgent",
    options
  );
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function start(
  format = {
    encoding: "audio/x-mulaw",
    sampleRate: 8000,
    channels: 1
  }
) {
  carrierSocket.emit(
    "message",
    JSON.stringify({
      event: "start",
      start: {
        streamSid: "stream-1",
        callSid: "call-1",
        mediaFormat: format
      }
    })
  );
  await tick();
}

describe("SignalWireAdapter", () => {
  it("uses the Call SID and starts the agent call", async () => {
    createAdapter();
    await start();
    expect(instanceNames).toEqual(["call-1"]);
    expect(agentSocket.json).toEqual([{ type: "start_call" }]);
  });

  it("forwards inbound PCMU as 16 kHz PCM", async () => {
    createAdapter();
    await start();
    carrierSocket.emit(
      "message",
      JSON.stringify({
        event: "media",
        media: { track: "inbound", payload: btoa("\xff".repeat(160)) }
      })
    );
    const audio = agentSocket.sent.find(
      (value): value is ArrayBuffer => value instanceof ArrayBuffer
    );
    expect(audio?.byteLength).toBe(640);
  });

  it("returns agent PCM as SignalWire media", async () => {
    createAdapter();
    await start();
    agentSocket.emit("message", new Int16Array(320).buffer);
    expect(carrierSocket.json).toContainEqual({
      event: "media",
      streamSid: "stream-1",
      media: { payload: expect.any(String) }
    });
  });

  it("routes to the kebab-cased agent path for multi-word class names", async () => {
    createAdapter();
    await start();
    expect(new URL(fetchedRequests[0].url).pathname).toBe(
      "/agents/my-agent/call-1"
    );
  });

  it("forwards agent audio unchanged when agentAudioFormat is mulaw", async () => {
    createAdapter({ agentAudioFormat: "mulaw" });
    await start();
    const bytes = new Uint8Array([0xff, 0x00, 0x7e, 0x81]);
    agentSocket.emit("message", bytes.buffer);
    const sent = carrierSocket.json.find((m) => m.event === "media") as {
      media: { payload: string };
    };
    expect(sent.media.payload).toBe(btoa(String.fromCharCode(...bytes)));
  });

  it("takes the outbound rate from the agent's audio_config, not a guess", async () => {
    createAdapter();
    await start();
    // The agent announces its TTS provider's real rate. 24 kHz in must come
    // back out as 8 kHz μ-law — a 3:1 reduction. If the adapter ignored
    // audio_config it would assume 16000 and emit 12 bytes instead of 8.
    agentSocket.emit(
      "message",
      JSON.stringify({
        type: "audio_config",
        format: "pcm16",
        sampleRate: 24000
      })
    );
    agentSocket.emit("message", new Int16Array(24).buffer);
    const sent = carrierSocket.json.find((m) => m.event === "media") as {
      media: { payload: string };
    };
    expect(atob(sent.media.payload).length).toBe(8);
  });

  it("preserves the waveform through the μ-law round trip", async () => {
    createAdapter({ sttSampleRate: 8000 });
    await start();
    // A byte-count assertion cannot tell a correct conversion from a broken
    // one, so decode the audio the agent receives and compare it to the
    // amplitudes actually encoded. μ-law is lossy, hence the tolerance.
    const source = [0, 8000, -8000, 24000, -24000, 1000, -1000, 32000];
    const mulaw = Uint8Array.from(source, encodeMulawReference);
    carrierSocket.emit(
      "message",
      JSON.stringify({
        event: "media",
        media: {
          track: "inbound",
          payload: btoa(String.fromCharCode(...mulaw))
        }
      })
    );
    const audio = agentSocket.sent.find(
      (value): value is ArrayBuffer => value instanceof ArrayBuffer
    );
    const decoded = Array.from(new Int16Array(audio as ArrayBuffer));
    expect(decoded.length).toBe(source.length);
    for (let i = 0; i < source.length; i++) {
      expect(Math.abs(decoded[i] - source[i])).toBeLessThan(
        Math.abs(source[i]) * 0.08 + 64
      );
    }
  });

  it("resamples inbound audio to the configured STT rate", async () => {
    createAdapter();
    await start();
    const payload = btoa(String.fromCharCode(0xff, 0x00, 0x7e, 0x81));
    carrierSocket.emit(
      "message",
      JSON.stringify({
        event: "media",
        media: { track: "inbound", payload }
      })
    );
    const audio = agentSocket.sent.find(
      (value): value is ArrayBuffer => value instanceof ArrayBuffer
    );
    // 4 μ-law samples at 8 kHz upsampled to Flux's 16 kHz = 8 samples.
    expect(new Int16Array(audio as ArrayBuffer).length).toBe(8);
  });

  it("ends the agent call on SignalWire stop", async () => {
    createAdapter();
    await start();
    carrierSocket.emit("message", JSON.stringify({ event: "stop" }));
    expect(agentSocket.json.at(-1)).toEqual({ type: "end_call" });
    expect(agentSocket.closed).toBe(true);
  });

  it("rejects a stream whose codec violates the adapter contract", async () => {
    createAdapter();
    await start({ encoding: "audio/x-L16", sampleRate: 16000, channels: 1 });
    expect(carrierSocket.closed).toBe(true);
    expect(instanceNames).toEqual([]);
  });
});

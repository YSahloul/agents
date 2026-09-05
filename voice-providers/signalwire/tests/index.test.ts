import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { SignalWireAdapter } from "../src/index.js";
import { AmbientOutput } from "../src/audio/ambient-output.js";
import type { SignalWireAdapterOptions } from "../src/index.js";
import {
  arrayBufferToBase64,
  base64ToArrayBuffer
} from "../src/audio/utils.js";

// WebSocketPair and status 101 responses are Cloudflare Workers runtime APIs
// not available in Node/vitest. Stubs below let SignalWireAdapter be
// unit-tested.

type Handler = (event: { data?: unknown }) => void;

class FakeWebSocket {
  readyState = 1; // OPEN
  sent: unknown[] = [];
  closed = false;
  closeCode?: number;
  closeReason?: string;
  private handlers = new Map<string, Handler[]>();

  accept() {}

  send(data: unknown) {
    this.sent.push(data);
  }

  close(code?: number, reason?: string) {
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
    this.readyState = 3; // CLOSED
  }

  addEventListener(event: string, handler: Handler) {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }

  emit(event: string, payload?: { data?: unknown }) {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(payload ?? {});
    }
  }

  get jsonSent(): Record<string, unknown>[] {
    return this.sent
      .filter((d): d is string => typeof d === "string")
      .map((d) => JSON.parse(d) as Record<string, unknown>);
  }

  get binarySent(): ArrayBuffer[] {
    return this.sent.filter((d): d is ArrayBuffer => d instanceof ArrayBuffer);
  }
}

let lastPair: { signalWire: FakeWebSocket; server: FakeWebSocket } | null =
  null;

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

function decodeMulawReference(byte: number): number {
  const mu = ~byte & 0xff;
  const sign = mu & 0x80;
  const exponent = (mu >> 4) & 0x07;
  const mantissa = mu & 0x0f;
  let sample = ((mantissa << 3) + 0x84) << exponent;
  sample -= 0x84;
  return sign ? -sample : sample;
}

function pcmToMulawBase64(samples: Int16Array): string {
  const bytes = new Uint8Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    bytes[i] = encodeMulawReference(samples[i]);
  }
  return arrayBufferToBase64(bytes.buffer as ArrayBuffer);
}

beforeAll(() => {
  (globalThis as unknown as Record<string, unknown>)["WebSocketPair"] =
    function (this: Record<number, FakeWebSocket>) {
      this[0] = new FakeWebSocket();
      this[1] = new FakeWebSocket();
      lastPair = { signalWire: this[0], server: this[1] };
    };

  // Node's Response rejects status 101 (Workers-only). Patch it to accept
  // any status — what matters in tests is the WebSocket wiring, not the
  // status line.
  const OriginalResponse = globalThis.Response;
  (globalThis as unknown as Record<string, unknown>)["Response"] =
    class extends OriginalResponse {
      constructor(body?: BodyInit | null, init?: ResponseInit) {
        if (init?.status === 101) {
          super(body, { ...init, status: 200 });
        } else {
          super(body, init);
        }
      }
    };
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// --- Bridge harness ---

interface Harness {
  serverSocket: FakeWebSocket;
  agentSocket: FakeWebSocket;
  idFromNameCalls: string[];
  fetchedRequests: Request[];
  response: Response;
}

function createHarness(options?: SignalWireAdapterOptions): Harness {
  const agentSocket = new FakeWebSocket();
  const idFromNameCalls: string[] = [];
  const fetchedRequests: Request[] = [];
  const env = {
    MyAgent: {
      idFromName(name: string) {
        idFromNameCalls.push(name);
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
  const request = new Request("https://example.com/signalwire", {
    headers: { Upgrade: "websocket" }
  });
  const response = SignalWireAdapter.handleRequest(
    request,
    env,
    "MyAgent",
    options
  );
  if (!lastPair) throw new Error("WebSocketPair was not constructed");
  return {
    serverSocket: lastPair.server,
    agentSocket,
    idFromNameCalls,
    fetchedRequests,
    response
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function startCall(
  harness: Harness,
  callSid = "call-1",
  streamSid = "stream-1",
  format = { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 }
) {
  harness.serverSocket.emit("message", {
    data: JSON.stringify({
      event: "start",
      start: { streamSid, callSid, tracks: ["inbound"], mediaFormat: format }
    })
  });
  await tick();
}

function sendMedia(harness: Harness, samples: Int16Array, track = "inbound") {
  harness.serverSocket.emit("message", {
    data: JSON.stringify({
      event: "media",
      streamSid: "stream-1",
      media: { track, payload: pcmToMulawBase64(samples) }
    })
  });
}

function mediaPayload(message: Record<string, unknown> | undefined): string {
  if (!message || !("media" in message)) {
    throw new Error("Expected media message");
  }
  const media = message.media;
  if (!media || typeof media !== "object" || !("payload" in media)) {
    throw new Error("Expected media payload");
  }
  const payload = media.payload;
  if (typeof payload !== "string") throw new Error("Expected base64 payload");
  return payload;
}

describe("SignalWireAdapter.handleRequest", () => {
  it("returns 426 when request is not a WebSocket upgrade", () => {
    const request = new Request("https://example.com/signalwire");
    const response = SignalWireAdapter.handleRequest(request, {}, "MyAgent");
    expect(response.status).toBe(426);
  });

  it("accepts a WebSocket upgrade request", () => {
    const { response } = createHarness();
    // In Workers the status would be 101; the Response patch substitutes 200.
    expect(response.status).not.toBe(426);
    expect(response.status).not.toBeGreaterThanOrEqual(400);
  });

  it("connects to the agent and opts into playback markers on start", async () => {
    const harness = createHarness();
    await startCall(harness);
    expect(harness.agentSocket.jsonSent).toEqual([
      {
        type: "start_call",
        playback_markers: true,
        playback_marker_acks: true
      }
    ]);
  });

  it("uses the SignalWire callSid as the agent instance name by default", async () => {
    const harness = createHarness();
    await startCall(harness, "call-abc");
    expect(harness.idFromNameCalls).toEqual(["call-abc"]);
  });

  it("uses options.instanceName for the agent instance when given", async () => {
    const harness = createHarness({ instanceName: "shared" });
    await startCall(harness, "call-abc");
    expect(harness.idFromNameCalls).toEqual(["shared"]);
  });

  it("routes to the kebab-cased agent path for multi-word class names", async () => {
    const harness = createHarness();
    await startCall(harness);
    expect(new URL(harness.fetchedRequests[0].url).pathname).toBe(
      "/agents/my-agent/call-1"
    );
  });

  it("rejects a stream whose codec violates the adapter contract", async () => {
    const harness = createHarness();
    await startCall(harness, "call-1", "stream-1", {
      encoding: "audio/x-L16",
      sampleRate: 16000,
      channels: 1
    });
    expect(harness.serverSocket.closed).toBe(true);
    expect(harness.idFromNameCalls).toEqual([]);
  });

  it("logs and survives a missing DO namespace", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const request = new Request("https://example.com/signalwire", {
      headers: { Upgrade: "websocket" }
    });
    SignalWireAdapter.handleRequest(request, {}, "MyAgent");
    if (!lastPair) throw new Error("WebSocketPair was not constructed");
    lastPair.server.emit("message", {
      data: JSON.stringify({
        event: "start",
        start: {
          streamSid: "s",
          callSid: "c",
          tracks: [],
          mediaFormat: {
            encoding: "audio/x-mulaw",
            sampleRate: 8000,
            channels: 1
          }
        }
      })
    });
    await tick();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("not found in env")
    );
  });

  it("ignores binary frames and invalid JSON from SignalWire", async () => {
    const harness = createHarness();
    await startCall(harness);
    harness.serverSocket.emit("message", { data: new ArrayBuffer(4) });
    harness.serverSocket.emit("message", { data: "not json" });
    // Only start_call so far; nothing crashed, nothing extra sent.
    expect(harness.agentSocket.sent).toHaveLength(1);
  });

  it("drops media that arrives before start", () => {
    const harness = createHarness();
    sendMedia(harness, new Int16Array(160));
    expect(harness.agentSocket.sent).toHaveLength(0);
  });

  it("ignores media on non-inbound tracks", async () => {
    const harness = createHarness();
    await startCall(harness);
    sendMedia(harness, new Int16Array(160), "outbound");
    expect(harness.agentSocket.binarySent).toHaveLength(0);
  });

  it("forwards dtmf events to the agent verbatim", async () => {
    const harness = createHarness();
    await startCall(harness);
    const dtmf = {
      event: "dtmf",
      streamSid: "stream-1",
      dtmf: { digit: "5", duration: 100 }
    };
    harness.serverSocket.emit("message", { data: JSON.stringify(dtmf) });
    expect(harness.agentSocket.jsonSent).toContainEqual(dtmf);
  });

  it("sends end_call and closes the agent socket on SignalWire stop", async () => {
    const harness = createHarness();
    await startCall(harness);
    harness.serverSocket.emit("message", {
      data: JSON.stringify({ event: "stop" })
    });
    expect(harness.agentSocket.jsonSent).toContainEqual({ type: "end_call" });
    expect(harness.agentSocket.closed).toBe(true);
  });

  it("sends end_call and closes the agent socket when SignalWire disconnects", async () => {
    const harness = createHarness();
    await startCall(harness);
    harness.serverSocket.emit("close");
    expect(harness.agentSocket.jsonSent).toContainEqual({ type: "end_call" });
    expect(harness.agentSocket.closed).toBe(true);
  });

  it("closes the SignalWire socket when the agent disconnects", async () => {
    const harness = createHarness();
    await startCall(harness);
    harness.agentSocket.emit("close");
    expect(harness.serverSocket.closed).toBe(true);
  });
});

describe("inbound audio path (mulaw 8kHz → PCM 16kHz)", () => {
  it("decodes, upsamples, and forwards inbound audio to the agent", async () => {
    const harness = createHarness();
    await startCall(harness);
    sendMedia(harness, new Int16Array(160)); // 20ms of silence at 8kHz
    expect(harness.agentSocket.binarySent).toHaveLength(1);
    const pcm = new Int16Array(harness.agentSocket.binarySent[0]);
    expect(pcm).toHaveLength(320); // doubled by 8→16kHz resample
    expect(pcm.every((s) => s === 0)).toBe(true);
  });

  it("round-trips a constant tone within mulaw quantization error", async () => {
    const harness = createHarness();
    await startCall(harness);
    const amplitude = 10_000;
    sendMedia(harness, new Int16Array(160).fill(amplitude));
    const pcm = new Int16Array(harness.agentSocket.binarySent[0]);
    expect(pcm).toHaveLength(320);
    for (const sample of pcm) {
      expect(Math.abs(sample - amplitude)).toBeLessThan(300);
    }
  });

  it("preserves the waveform through the μ-law round trip", async () => {
    const harness = createHarness();
    await startCall(harness);
    const source = [0, 8000, -8000, 24000, -24000, 1000, -1000, 32000];
    const mulaw = Uint8Array.from(source, encodeMulawReference);
    harness.serverSocket.emit("message", {
      data: JSON.stringify({
        event: "media",
        streamSid: "stream-1",
        media: {
          track: "inbound",
          payload: btoa(String.fromCharCode(...mulaw))
        }
      })
    });
    const decoded = Array.from(
      new Int16Array(harness.agentSocket.binarySent[0])
    );
    expect(decoded.length).toBe(source.length * 2); // 8→16kHz resample
    for (let i = 0; i < source.length; i++) {
      expect(Math.abs(decoded[i * 2] - source[i])).toBeLessThan(
        Math.abs(source[i]) * 0.08 + 64
      );
    }
    void decodeMulawReference;
  });
});

describe("outbound audio path (PCM 16kHz → mulaw 8kHz media)", () => {
  it("downsamples, encodes, and wraps agent audio in a media event", async () => {
    const harness = createHarness();
    await startCall(harness);
    const amplitude = 10_000;
    const pcm = new Int16Array(320).fill(amplitude);
    harness.agentSocket.emit("message", { data: pcm.buffer });

    const media = harness.serverSocket.jsonSent.find(
      (message) => message.event === "media"
    );
    expect(media).toBeDefined();
    expect(media?.streamSid).toBe("stream-1");
    const payload = mediaPayload(media);

    const mulawBytes = new Uint8Array(base64ToArrayBuffer(payload));
    expect(mulawBytes).toHaveLength(160); // halved by 16→8kHz resample
    for (const byte of mulawBytes) {
      expect(Math.abs(decodeMulawReference(byte) - amplitude)).toBeLessThan(
        300
      );
    }
  });

  it.each([
    [16000, 320, 160],
    [24000, 480, 160]
  ])(
    "converts declared PCM16/%i audio to 8 kHz",
    async (sampleRate, inputBytes, outputBytes) => {
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
        data: new Int16Array(inputBytes / 2).buffer
      });

      const media = harness.serverSocket.jsonSent.find(
        (message) => message.event === "media"
      );
      const payload = mediaPayload(media);
      expect(new Uint8Array(base64ToArrayBuffer(payload))).toHaveLength(
        outputBytes / 2
      );
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

    const media = harness.serverSocket.jsonSent.find(
      (message) => message.event === "media"
    );
    const payload = mediaPayload(media);
    expect(new Uint8Array(base64ToArrayBuffer(payload))).toEqual(mulaw);
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

    expect(
      harness.serverSocket.jsonSent.some((message) => message.event === "media")
    ).toBe(false);
    expect(harness.agentSocket.closeCode).toBe(1003);
    expect(harness.serverSocket.closeCode).toBe(1003);
    expect(harness.agentSocket.closeReason).toBe(
      "Unsupported agent audio format"
    );
  });

  it("ignores agent audio that arrives before start", () => {
    const harness = createHarness();
    // Emit on a socket that was never connected — nothing should reach
    // SignalWire.
    harness.agentSocket.emit("message", { data: new ArrayBuffer(8) });
    expect(harness.serverSocket.jsonSent).toHaveLength(0);
  });
  it("paces buffered mulaw frames at the 8 kHz carrier rate", async () => {
    const harness = createHarness();
    await startCall(harness);
    harness.agentSocket.emit("message", {
      data: JSON.stringify({
        type: "audio_config",
        format: "mulaw",
        sampleRate: 8000
      })
    });
    vi.useFakeTimers({ now: 1000 });
    const mediaSentAt: number[] = [];
    const send = harness.serverSocket.send.bind(harness.serverSocket);
    vi.spyOn(harness.serverSocket, "send").mockImplementation((data) => {
      if (
        typeof data === "string" &&
        (JSON.parse(data) as Record<string, unknown>).event === "media"
      ) {
        mediaSentAt.push(Date.now());
      }
      send(data);
    });

    harness.agentSocket.emit("message", { data: new ArrayBuffer(160) });
    harness.agentSocket.emit("message", { data: new ArrayBuffer(160) });
    harness.agentSocket.emit("message", {
      data: JSON.stringify({
        type: "playback_marker",
        playbackId: "paced",
        sequence: 1,
        text: "Paced sentence."
      })
    });

    expect(mediaSentAt).toEqual([1000]);
    expect(
      harness.serverSocket.jsonSent.some(
        (message) =>
          message.event === "mark" &&
          (message.mark as { name?: string } | undefined)?.name ===
            "playback:paced:1"
      )
    ).toBe(false);

    await vi.advanceTimersByTimeAsync(19);
    expect(mediaSentAt).toEqual([1000]);
    await vi.advanceTimersByTimeAsync(1);
    expect(mediaSentAt).toEqual([1000, 1020]);
    expect(
      harness.serverSocket.jsonSent.some(
        (message) =>
          message.event === "mark" &&
          (message.mark as { name?: string } | undefined)?.name ===
            "playback:paced:1"
      )
    ).toBe(true);
  });
  it("clears immediately without waiting for paced media", async () => {
    const harness = createHarness();
    await startCall(harness);
    harness.agentSocket.emit("message", {
      data: JSON.stringify({
        type: "audio_config",
        format: "mulaw",
        sampleRate: 8000
      })
    });
    vi.useFakeTimers({ now: 1000 });

    harness.agentSocket.emit("message", { data: new ArrayBuffer(160) });
    harness.agentSocket.emit("message", { data: new ArrayBuffer(160) });
    expect(
      harness.serverSocket.jsonSent.filter(
        (message) => message.event === "media"
      )
    ).toHaveLength(1);

    harness.agentSocket.emit("message", {
      data: JSON.stringify({ type: "playback_interrupt" })
    });

    expect(
      harness.serverSocket.jsonSent.filter(
        (message) => message.event === "clear"
      )
    ).toEqual([{ event: "clear", streamSid: "stream-1" }]);
    await vi.advanceTimersByTimeAsync(20);
    expect(
      harness.serverSocket.jsonSent.filter(
        (message) => message.event === "media"
      )
    ).toHaveLength(1);
  });
});

describe("agent JSON messages → SignalWire marks", () => {
  it("forwards transcript and status messages as mark events", async () => {
    const harness = createHarness();
    await startCall(harness);
    const transcript = { type: "transcript", text: "hello" };
    harness.agentSocket.emit("message", { data: JSON.stringify(transcript) });

    const mark = harness.serverSocket.jsonSent.find((m) => m.event === "mark");
    expect(mark).toBeDefined();
    expect(mark?.streamSid).toBe("stream-1");
    expect(JSON.parse((mark!.mark as { name: string }).name)).toEqual(
      transcript
    );
  });
  it("orders media markers and acknowledges playback lifecycle", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const harness = createHarness();
    await startCall(harness);
    harness.agentSocket.emit("message", {
      data: JSON.stringify({
        type: "audio_config",
        format: "mulaw",
        sampleRate: 8000
      })
    });
    harness.agentSocket.emit("message", { data: new ArrayBuffer(3) });
    harness.agentSocket.emit("message", {
      data: JSON.stringify({
        type: "playback_marker",
        playbackId: "playback-1",
        sequence: 1,
        text: "First sentence."
      })
    });
    harness.agentSocket.emit("message", { data: new ArrayBuffer(4) });
    harness.agentSocket.emit("message", {
      data: JSON.stringify({
        type: "playback_marker",
        playbackId: "playback-1",
        sequence: 2,
        text: "Second sentence."
      })
    });
    await tick();

    const outbound = harness.serverSocket.jsonSent.filter(
      (message) =>
        message.event === "media" ||
        (message.event === "mark" &&
          typeof message.mark === "object" &&
          message.mark !== null &&
          "name" in message.mark &&
          typeof message.mark.name === "string" &&
          message.mark.name.startsWith("playback:"))
    );
    expect(outbound.map((message) => message.event)).toEqual([
      "media",
      "mark",
      "media",
      "mark"
    ]);
    const playbackMarks = outbound.filter(
      (message) =>
        message.event === "mark" &&
        typeof message.mark === "object" &&
        message.mark !== null &&
        "name" in message.mark &&
        typeof message.mark.name === "string" &&
        message.mark.name.startsWith("playback:")
    );
    const firstMarkName = (playbackMarks[0].mark as { name: string }).name;
    const secondMarkName = (playbackMarks[1].mark as { name: string }).name;
    expect(firstMarkName).toBe("playback:playback-1:1");
    expect(secondMarkName).toBe("playback:playback-1:2");

    const traces = logSpy.mock.calls
      .filter((call) => call[0] === "[VoiceTrace]")
      .map((call) => call[1])
      .filter(
        (value): value is Record<string, unknown> =>
          typeof value === "object" && value !== null
      );
    expect(traces.filter((trace) => trace.event === "tts_sent")).toEqual([
      expect.objectContaining({
        event: "tts_sent",
        playbackId: "playback-1",
        sequence: 1,
        text: "First sentence.",
        frames: 1,
        bytes: 3
      }),
      expect.objectContaining({
        event: "tts_sent",
        playbackId: "playback-1",
        sequence: 2,
        text: "Second sentence.",
        frames: 1,
        bytes: 4
      })
    ]);

    harness.serverSocket.emit("message", {
      data: JSON.stringify({ event: "mark", mark: { name: "unrelated" } })
    });
    harness.serverSocket.emit("message", {
      data: JSON.stringify({
        event: "mark",
        mark: { name: firstMarkName }
      })
    });
    harness.serverSocket.emit("message", {
      data: JSON.stringify({
        event: "mark",
        mark: { name: secondMarkName }
      })
    });
    harness.serverSocket.emit("message", {
      data: JSON.stringify({
        event: "mark",
        mark: { name: secondMarkName }
      })
    });
    await tick();
    expect(
      harness.agentSocket.jsonSent.filter(
        (message) => message.type === "playback_marker_ack"
      )
    ).toEqual([
      {
        type: "playback_marker_ack",
        playbackId: "playback-1",
        sequence: 1
      },
      {
        type: "playback_marker_ack",
        playbackId: "playback-1",
        sequence: 2
      }
    ]);

    expect(traces.filter((trace) => trace.event === "tts_played")).toEqual([]);
    const playedTraces = logSpy.mock.calls
      .filter((call) => call[0] === "[VoiceTrace]")
      .map((call) => call[1])
      .filter(
        (value): value is Record<string, unknown> =>
          typeof value === "object" &&
          value !== null &&
          value.event === "tts_played"
      );
    expect(playedTraces).toEqual([
      expect.objectContaining({ playbackId: "playback-1", sequence: 1 }),
      expect.objectContaining({ playbackId: "playback-1", sequence: 2 })
    ]);
  });

  it("serializes Blob audio before its playback marker", async () => {
    const harness = createHarness();
    await startCall(harness);
    harness.agentSocket.emit("message", {
      data: new Blob([new Uint8Array([1, 2, 3, 4])])
    });
    harness.agentSocket.emit("message", {
      data: JSON.stringify({
        type: "playback_marker",
        playbackId: "blob-playback",
        sequence: 1,
        text: "Blob sentence."
      })
    });
    await tick();

    const outbound = harness.serverSocket.jsonSent.filter(
      (message) =>
        message.event === "media" ||
        (message.event === "mark" &&
          typeof message.mark === "object" &&
          message.mark !== null &&
          "name" in message.mark &&
          typeof message.mark.name === "string" &&
          message.mark.name === "playback:blob-playback:1")
    );
    expect(outbound.map((message) => message.event)).toEqual(["media", "mark"]);
  });

  it("ignores non-JSON agent messages", async () => {
    const harness = createHarness();
    await startCall(harness);
    harness.agentSocket.emit("message", { data: "not json" });
    expect(harness.serverSocket.jsonSent).toHaveLength(0);
  });
});

describe("carrier playback control", () => {
  const loud = new Int16Array(160).fill(1000);

  it("forwards inbound audio while agent playback is active", async () => {
    const harness = createHarness();
    await startCall(harness);
    harness.agentSocket.emit("message", {
      data: JSON.stringify({ type: "status", status: "speaking" })
    });

    sendMedia(harness, loud);

    expect(harness.agentSocket.binarySent).toHaveLength(1);
  });

  it("does not clear playback from raw inbound energy", async () => {
    const harness = createHarness();
    await startCall(harness);
    harness.agentSocket.emit("message", {
      data: new Int16Array(320).fill(5000).buffer
    });

    for (let i = 0; i < 6; i++) sendMedia(harness, loud);

    expect(
      harness.serverSocket.jsonSent.filter((m) => m.event === "clear")
    ).toHaveLength(0);
  });

  it("clears playback without suppressing later inbound audio", async () => {
    const harness = createHarness();
    await startCall(harness);
    sendMedia(harness, loud);

    harness.agentSocket.emit("message", {
      data: JSON.stringify({ type: "playback_interrupt" })
    });
    sendMedia(harness, loud);

    expect(
      harness.serverSocket.jsonSent.filter((m) => m.event === "clear")
    ).toEqual([{ event: "clear", streamSid: "stream-1" }]);
    expect(harness.agentSocket.binarySent).toHaveLength(2);
  });
  it("discards pending playback acknowledgements after clear", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const harness = createHarness();
    await startCall(harness);
    harness.agentSocket.emit("message", { data: new ArrayBuffer(4) });
    harness.agentSocket.emit("message", {
      data: JSON.stringify({
        type: "playback_marker",
        playbackId: "interrupted",
        sequence: 1,
        text: "Interrupted sentence."
      })
    });
    await tick();
    const mark = harness.serverSocket.jsonSent.find(
      (message) =>
        message.event === "mark" &&
        typeof message.mark === "object" &&
        message.mark !== null &&
        "name" in message.mark &&
        typeof message.mark.name === "string" &&
        message.mark.name.startsWith("playback:")
    );
    const markName = (mark?.mark as { name: string } | undefined)?.name;
    expect(markName).toBe("playback:interrupted:1");

    harness.agentSocket.emit("message", {
      data: JSON.stringify({ type: "playback_interrupt" })
    });
    await tick();
    harness.serverSocket.emit("message", {
      data: JSON.stringify({ event: "mark", mark: { name: markName } })
    });
    await tick();
    expect(
      harness.agentSocket.jsonSent.filter(
        (message) => message.type === "playback_marker_ack"
      )
    ).toEqual([]);

    expect(
      logSpy.mock.calls
        .map((call) => call[1])
        .filter(
          (value): value is Record<string, unknown> =>
            typeof value === "object" &&
            value !== null &&
            value.event === "tts_played"
        )
    ).toEqual([]);
  });
});

describe("continuous ambient output", () => {
  const mulaw = (samples: Int16Array) =>
    new Uint8Array(base64ToArrayBuffer(pcmToMulawBase64(samples)));

  it("loops real ambience during silence and mixes it under speech", async () => {
    vi.useFakeTimers();
    const sent: Uint8Array[] = [];
    const markers: Array<{ frames: number; bytes: number }> = [];
    const output = new AmbientOutput({
      audio: mulaw(new Int16Array(160).fill(1000)),
      volume: 0.5,
      sendAudio: (audio) => sent.push(audio),
      sendMarker: (_marker, metrics) => markers.push(metrics)
    });

    output.start();
    await vi.advanceTimersByTimeAsync(20);
    expect(decodeMulawReference(sent[0][0])).toBeGreaterThan(400);

    output.enqueueAudio(mulaw(new Int16Array(160).fill(2000)));
    expect(
      output.enqueueMarker({
        type: "playback_marker",
        playbackId: "ambient",
        sequence: 1,
        text: "Hello."
      })
    ).toBe(true);
    await vi.advanceTimersByTimeAsync(20);
    expect(decodeMulawReference(sent[1][0])).toBeGreaterThan(2300);
    await vi.advanceTimersByTimeAsync(20);
    expect(markers).toEqual([{ frames: 1, bytes: 160 }]);
    expect(decodeMulawReference(sent[2][0])).toBeGreaterThan(400);

    output.clear();
    await vi.advanceTimersByTimeAsync(20);
    expect(decodeMulawReference(sent[3][0])).toBeGreaterThan(400);
    output.stop();
    await vi.advanceTimersByTimeAsync(20);
    expect(sent).toHaveLength(4);
  });

  it("starts and stops the ambient pump with the SignalWire call", async () => {
    vi.useFakeTimers();
    const harness = createHarness({
      ambientAudio: mulaw(new Int16Array(160).fill(1000)),
      ambientVolume: 0.5
    });

    harness.serverSocket.emit("message", {
      data: JSON.stringify({
        event: "start",
        start: {
          streamSid: "stream-1",
          callSid: "call-1",
          tracks: ["inbound"],
          mediaFormat: {
            encoding: "audio/x-mulaw",
            sampleRate: 8000,
            channels: 1
          }
        }
      })
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(20);
    expect(
      harness.serverSocket.jsonSent.filter((message) => message.event === "media")
    ).toHaveLength(1);

    harness.serverSocket.emit("message", {
      data: JSON.stringify({ event: "stop" })
    });
    await vi.advanceTimersByTimeAsync(40);
    expect(
      harness.serverSocket.jsonSent.filter((message) => message.event === "media")
    ).toHaveLength(1);
  });
});

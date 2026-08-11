import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SFUVoiceTransport, type SFUVoiceState } from "../sfu-transport";
import {
  encodePayloadToProtobuf,
  extractPayloadFromProtobuf
} from "../sfu-utils";

const CONFIG = { appId: "app", apiToken: "token" };

type FetchCall = { path: string; body: unknown };

function createSfuFetchMock() {
  const calls: FetchCall[] = [];
  let session = 0;
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ path, body });

      if (path.endsWith("/sessions/new")) {
        session++;
        return Response.json({ sessionId: `session-${session}` });
      }
      if (path.endsWith("/tracks/new")) {
        if (
          typeof body === "object" &&
          body !== null &&
          "autoDiscover" in body
        ) {
          return Response.json({
            sessionDescription: { type: "answer", sdp: "stt-answer" },
            tracks: [{ kind: "audio", trackName: "mic-track" }]
          });
        }
        return Response.json({
          sessionDescription: { type: "answer", sdp: "tts-answer" }
        });
      }
      if (path.endsWith("/adapters/websocket/new")) {
        if (
          typeof body === "object" &&
          body !== null &&
          "tracks" in body &&
          Array.isArray(body.tracks) &&
          typeof body.tracks[0] === "object" &&
          body.tracks[0] !== null &&
          "location" in body.tracks[0] &&
          body.tracks[0].location === "local"
        ) {
          return Response.json({
            tracks: [{ sessionId: "tts-session", adapterId: "tts-adapter" }]
          });
        }
        return Response.json({ tracks: [{ adapterId: "stt-adapter" }] });
      }
      if (path.endsWith("/adapters/websocket/close")) {
        return Response.json({});
      }
      if (path.endsWith("/renegotiate")) {
        return Response.json({
          sessionDescription: { type: "answer", sdp: "renegotiated" }
        });
      }
      return new Response("missing mock", { status: 500 });
    }
  );
  return { calls, fetchMock };
}

function upgrade(transport: SFUVoiceTransport, path: string): WebSocket {
  const response = transport.handleWebSocketUpgrade(
    new Request(`https://example.com/agents/my-agent/alice${path}`, {
      method: "GET",
      headers: { Upgrade: "websocket" }
    })
  );
  expect(response?.status).toBe(101);
  const socket = (response as Response & { webSocket?: WebSocket }).webSocket;
  expect(socket).toBeDefined();
  socket!.accept();
  socket!.binaryType = "arraybuffer";
  return socket!;
}

function nextSocketMessage(socket: WebSocket): Promise<ArrayBuffer> {
  return new Promise((resolve) => {
    socket.addEventListener(
      "message",
      (event) => resolve(event.data as ArrayBuffer),
      { once: true }
    );
  });
}

function constantStereoFrame(value: number): Uint8Array {
  const samples = new Int16Array(960 * 2);
  samples.fill(value);
  return new Uint8Array(samples.buffer);
}

describe("SFUVoiceTransport", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("publishes, connects, forwards, and converts audio in both directions", async () => {
    const { calls, fetchMock } = createSfuFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    const saved: Array<SFUVoiceState | null> = [];
    const received: ArrayBuffer[] = [];
    const transport = new SFUVoiceTransport({
      config: CONFIG,
      saveState: async (state) => {
        saved.push(state);
      }
    });

    const ttsSocket = upgrade(transport, "/voice/tts/subscribe");
    await transport.start("call", (audio) => received.push(audio));

    const publish = await transport.handleHttpRequest(
      new Request(
        "https://example.com/agents/my-agent/alice/voice/tts/publish",
        { method: "POST" }
      )
    );
    expect(publish?.status).toBe(200);
    const publishBody = (await publish!.json()) as { trackName: string };
    const ttsAdapterCall = calls.find((call) =>
      call.path.endsWith("/adapters/websocket/new")
    );
    expect(ttsAdapterCall?.body).toEqual({
      tracks: [
        expect.objectContaining({
          location: "local",
          trackName: publishBody.trackName,
          endpoint:
            "wss://example.com/agents/my-agent/alice/voice/tts/subscribe",
          inputCodec: "pcm",
          mode: "buffer"
        })
      ]
    });

    const ttsConnect = await transport.handleHttpRequest(
      new Request(
        "https://example.com/agents/my-agent/alice/voice/tts/connect",
        {
          method: "POST",
          body: JSON.stringify({
            sessionDescription: { type: "offer", sdp: "listener-offer" }
          })
        }
      )
    );
    expect(ttsConnect?.status).toBe(200);

    const sttConnect = await transport.handleHttpRequest(
      new Request(
        "https://example.com/agents/my-agent/alice/voice/stt/connect",
        {
          method: "POST",
          body: JSON.stringify({
            sessionDescription: { type: "offer", sdp: "mic-offer" }
          })
        }
      )
    );
    expect(sttConnect?.status).toBe(200);
    expect(saved.at(-1)?.stt?.callbackUrl).toBe(
      "wss://example.com/agents/my-agent/alice/voice/stt/sfu-subscribe"
    );

    const forwarding = await transport.handleHttpRequest(
      new Request(
        "https://example.com/agents/my-agent/alice/voice/stt/start-forwarding",
        { method: "POST" }
      )
    );
    expect(forwarding?.status).toBe(200);

    const sttSocket = upgrade(transport, "/voice/stt/sfu-subscribe");
    sttSocket.send(encodePayloadToProtobuf(constantStereoFrame(1234)));
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(new Int16Array(received[0])).toHaveLength(320);
    expect(new Set(new Int16Array(received[0]))).toEqual(new Set([1234]));

    const outgoing = nextSocketMessage(ttsSocket);
    const mono24k = new Int16Array(480);
    mono24k.fill(2345);
    transport.send("call", mono24k.buffer);
    await vi.advanceTimersByTimeAsync(20);
    const packet = await outgoing;
    const payload = extractPayloadFromProtobuf(packet);
    expect(payload?.byteLength).toBe(3840);
    expect(new Set(new Int16Array(payload!.buffer))).toEqual(new Set([2345]));
  });

  it("orders flush after queued speech and drops queued speech on interrupt", async () => {
    const { fetchMock } = createSfuFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    const transport = new SFUVoiceTransport({ config: CONFIG });
    const socket = upgrade(transport, "/voice/tts/subscribe");
    await transport.start("call", () => {});
    const mono24k = new Int16Array(480).buffer;

    const ordered: ArrayBuffer[] = [];
    socket.addEventListener("message", (event) => {
      ordered.push(event.data as ArrayBuffer);
    });
    transport.send("call", mono24k);
    transport.send("call", mono24k);
    const flushed = transport.flush("call");
    await vi.advanceTimersByTimeAsync(60);
    await flushed;
    await vi.waitFor(() => expect(ordered).toHaveLength(3));
    expect(
      ordered.map((packet) => extractPayloadFromProtobuf(packet)?.length)
    ).toEqual([3840, 3840, 0]);

    const interrupted: ArrayBuffer[] = [];
    socket.addEventListener("message", (event) => {
      interrupted.push(event.data as ArrayBuffer);
    });
    transport.send("call", mono24k);
    transport.send("call", mono24k);
    const discarded = transport.flush("call");
    transport.interrupt("call");
    await expect(discarded).rejects.toThrow("SFU output interrupted");
    await vi.waitFor(() => expect(interrupted).toHaveLength(1));
    expect(extractPayloadFromProtobuf(interrupted[0])?.length).toBe(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(interrupted).toHaveLength(1);
  });

  it("cleans adapters and persisted state once across idempotent stops", async () => {
    const { calls, fetchMock } = createSfuFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    const saved: Array<SFUVoiceState | null> = [];
    const transport = new SFUVoiceTransport({
      config: CONFIG,
      loadState: async () => ({
        tts: {
          sessionId: "tts-session",
          adapterId: "tts-adapter",
          trackName: "track"
        },
        stt: {
          sessionId: "stt-session",
          adapterId: "stt-adapter",
          trackName: "mic",
          callbackUrl: "wss://example.com/callback"
        }
      }),
      saveState: async (state) => {
        saved.push(state);
      }
    });
    upgrade(transport, "/voice/tts/subscribe");
    await transport.start("call", () => {});

    await transport.stop("call");
    await transport.stop("call");

    expect(
      calls.filter((call) => call.path.endsWith("/adapters/websocket/close"))
    ).toHaveLength(2);
    expect(saved.at(-1)).toBeNull();
    expect(() => transport.send("call", new ArrayBuffer(0))).toThrow(
      "SFU voice transport connection is not active"
    );
  });

  it("recovers from stale adapters that the SFU cannot close", async () => {
    const { fetchMock } = createSfuFetchMock();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (
          new URL(String(input)).pathname.endsWith("/adapters/websocket/close")
        ) {
          return new Response("Backend error", { status: 503 });
        }
        return fetchMock(input, init);
      })
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let state: SFUVoiceState | null = {
      tts: {
        sessionId: "stale-tts-session",
        adapterId: "stale-tts-adapter",
        trackName: "stale-tts"
      },
      stt: {
        sessionId: "stale-stt-session",
        adapterId: "stale-stt-adapter",
        trackName: "stale-stt",
        callbackUrl: "wss://example.com/callback"
      }
    };
    const transport = new SFUVoiceTransport({
      config: CONFIG,
      loadState: async () => state,
      saveState: async (nextState) => {
        state = nextState;
      }
    });
    upgrade(transport, "/voice/tts/subscribe");

    const publish = await transport.handleHttpRequest(
      new Request("https://example.com/voice/tts/publish", { method: "POST" })
    );
    expect(publish?.status).toBe(200);
    expect(state?.tts?.adapterId).toBe("tts-adapter");

    const stopForwarding = await transport.handleHttpRequest(
      new Request("https://example.com/voice/stt/stop-forwarding", {
        method: "POST"
      })
    );
    expect(stopForwarding?.status).toBe(200);
    expect(state?.stt?.adapterId).toBeUndefined();
  });

  it("falls through unmatched routes and returns 400 for missing state or SDP", async () => {
    const transport = new SFUVoiceTransport({ config: CONFIG });
    await expect(
      transport.handleHttpRequest(
        new Request("https://example.com/voice/other", { method: "POST" })
      )
    ).resolves.toBeNull();
    await expect(
      transport.handleHttpRequest(
        new Request("https://example.com/voice/tts/publish")
      )
    ).resolves.toBeNull();
    expect(
      transport.handleWebSocketUpgrade(
        new Request("https://example.com/voice/tts/subscribe")
      )
    ).toBeNull();

    const connect = await transport.handleHttpRequest(
      new Request("https://example.com/voice/tts/connect", {
        method: "POST",
        body: JSON.stringify({})
      })
    );
    expect(connect?.status).toBe(400);

    const stt = await transport.handleHttpRequest(
      new Request("https://example.com/voice/stt/connect", {
        method: "POST",
        body: JSON.stringify({})
      })
    );
    expect(stt?.status).toBe(400);
  });

  it("returns 500 for SFU failures and malformed successful responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unavailable", { status: 503 }))
    );
    const transport = new SFUVoiceTransport({ config: CONFIG });
    upgrade(transport, "/voice/tts/subscribe");
    const failed = await transport.handleHttpRequest(
      new Request("https://example.com/voice/tts/publish", { method: "POST" })
    );
    expect(failed?.status).toBe(500);
    expect(await failed?.text()).toContain("503");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ tracks: [{}] }))
    );
    const malformed = await transport.handleHttpRequest(
      new Request("https://example.com/voice/tts/publish", { method: "POST" })
    );
    expect(malformed?.status).toBe(500);
    expect(await malformed?.text()).toContain(
      "tracks[0].sessionId or tracks[0].adapterId"
    );
  });

  it("rejects callback timeouts and a second active connection", async () => {
    const timedOut = new SFUVoiceTransport({ config: CONFIG });
    const start = expect(timedOut.start("first", () => {})).rejects.toThrow(
      "SFU TTS callback timeout after 10s"
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await start;

    const active = new SFUVoiceTransport({ config: CONFIG });
    upgrade(active, "/voice/tts/subscribe");
    await active.start("first", () => {});
    await expect(active.start("second", () => {})).rejects.toThrow(
      "SFU voice transport already has an active call"
    );
  });

  it("times out a publish without an SFU callback and coalesces state loads", async () => {
    const { fetchMock } = createSfuFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    const loadState = vi.fn(async () => null);
    const transport = new SFUVoiceTransport({ config: CONFIG, loadState });

    const publishPromise = transport.handleHttpRequest(
      new Request("https://example.com/voice/tts/publish", { method: "POST" })
    );
    await vi.advanceTimersByTimeAsync(5_000);
    const publish = await publishPromise;
    expect(publish?.status).toBe(500);
    expect(await publish?.text()).toContain("callback timeout after 5s");
    expect(loadState).toHaveBeenCalledTimes(1);
  });
});

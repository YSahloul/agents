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
        const tracks =
          typeof body === "object" &&
          body !== null &&
          "tracks" in body &&
          Array.isArray(body.tracks)
            ? body.tracks
            : [];
        const firstTrack = tracks[0];
        if (
          typeof firstTrack === "object" &&
          firstTrack !== null &&
          "location" in firstTrack &&
          firstTrack.location === "local"
        ) {
          return Response.json({
            sessionDescription: { type: "answer", sdp: "rtc-answer" },
            tracks
          });
        }
        return Response.json({
          requiresImmediateRenegotiation: true,
          sessionDescription: { type: "offer", sdp: "rtc-pull-offer" },
          tracks
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
      if (path.endsWith("/renegotiate")) return Response.json({});
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

function tracksFromBody(body: unknown): unknown[] {
  if (
    typeof body !== "object" ||
    body === null ||
    !("tracks" in body) ||
    !Array.isArray(body.tracks)
  ) {
    return [];
  }
  return body.tracks;
}

describe("SFUVoiceTransport", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("uses one browser session for microphone, TTS, and STT forwarding", async () => {
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
    const primedAudio = nextSocketMessage(ttsSocket);
    await transport.start("call", (audio) => received.push(audio));

    const publish = await transport.handleHttpRequest(
      new Request(
        "https://example.com/agents/my-agent/alice/voice/tts/publish",
        { method: "POST" }
      )
    );
    expect(publish?.status).toBe(200);
    expect(
      new Uint8Array(extractPayloadFromProtobuf(await primedAudio)!)
    ).toEqual(constantStereoFrame(0));
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

    const connect = await transport.handleHttpRequest(
      new Request(
        "https://example.com/agents/my-agent/alice/voice/rtc/connect",
        {
          method: "POST",
          body: JSON.stringify({
            sessionDescription: { type: "offer", sdp: "browser-offer" },
            microphoneMid: "0"
          })
        }
      )
    );
    expect(connect?.status).toBe(200);

    const pull = await transport.handleHttpRequest(
      new Request("https://example.com/agents/my-agent/alice/voice/rtc/pull", {
        method: "POST"
      })
    );
    expect(pull?.status).toBe(200);
    await expect(pull?.json()).resolves.toMatchObject({
      requiresImmediateRenegotiation: true,
      sessionDescription: { type: "offer", sdp: "rtc-pull-offer" }
    });

    const renegotiate = await transport.handleHttpRequest(
      new Request(
        "https://example.com/agents/my-agent/alice/voice/rtc/renegotiate",
        {
          method: "POST",
          body: JSON.stringify({
            sessionDescription: { type: "answer", sdp: "browser-answer" }
          })
        }
      )
    );
    expect(renegotiate?.status).toBe(200);
    await expect(renegotiate?.json()).resolves.toEqual({});

    const sessionCalls = calls.filter((call) =>
      call.path.endsWith("/sessions/new")
    );
    expect(sessionCalls).toHaveLength(1);
    const trackCalls = calls.filter((call) =>
      call.path.endsWith("/tracks/new")
    );
    expect(trackCalls).toHaveLength(2);
    expect(trackCalls[0]).toEqual({
      path: "/v1/apps/app/sessions/session-1/tracks/new",
      body: {
        sessionDescription: { type: "offer", sdp: "browser-offer" },
        tracks: [
          {
            location: "local",
            mid: "0",
            trackName: expect.stringMatching(/^stt-/),
            kind: "audio"
          }
        ]
      }
    });
    const microphoneTrack = tracksFromBody(trackCalls[0].body)[0];
    if (
      typeof microphoneTrack !== "object" ||
      microphoneTrack === null ||
      !("trackName" in microphoneTrack) ||
      typeof microphoneTrack.trackName !== "string"
    ) {
      throw new Error("Expected local microphone track");
    }
    const microphoneTrackName = microphoneTrack.trackName;
    expect(trackCalls[1]).toEqual({
      path: "/v1/apps/app/sessions/session-1/tracks/new",
      body: {
        tracks: [
          {
            location: "remote",
            sessionId: "tts-session",
            trackName: publishBody.trackName,
            kind: "audio"
          }
        ]
      }
    });
    expect(calls.find((call) => call.path.endsWith("/renegotiate"))).toEqual({
      path: "/v1/apps/app/sessions/session-1/renegotiate",
      body: {
        sessionDescription: { type: "answer", sdp: "browser-answer" }
      }
    });
    expect(saved.at(-1)?.stt).toEqual({
      sessionId: "session-1",
      trackName: microphoneTrackName,
      callbackUrl:
        "wss://example.com/agents/my-agent/alice/voice/stt/sfu-subscribe"
    });

    const forwarding = await transport.handleHttpRequest(
      new Request(
        "https://example.com/agents/my-agent/alice/voice/stt/start-forwarding",
        { method: "POST" }
      )
    );
    expect(forwarding?.status).toBe(200);
    const sttAdapterCall = calls.find((call) => {
      const firstTrack = tracksFromBody(call.body)[0];
      return (
        call.path.endsWith("/adapters/websocket/new") &&
        typeof firstTrack === "object" &&
        firstTrack !== null &&
        "location" in firstTrack &&
        firstTrack.location === "remote"
      );
    });
    expect(sttAdapterCall?.body).toEqual({
      tracks: [
        {
          location: "remote",
          sessionId: "session-1",
          trackName: microphoneTrackName,
          endpoint:
            "wss://example.com/agents/my-agent/alice/voice/stt/sfu-subscribe",
          outputCodec: "pcm"
        }
      ]
    });

    const sttSocket = upgrade(transport, "/voice/stt/sfu-subscribe");
    sttSocket.send(encodePayloadToProtobuf(constantStereoFrame(1234)));
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(new Int16Array(received[0])).toHaveLength(320);
    expect(new Set(new Int16Array(received[0]))).toEqual(new Set([1234]));

    const outgoing = nextSocketMessage(ttsSocket);
    const mono24k = new Int16Array(480);
    mono24k.fill(2345);
    const bytes = new Uint8Array(mono24k.buffer);
    transport.send("call", bytes.slice(0, 501).buffer);
    transport.send("call", bytes.slice(501).buffer);
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

  it("ignores stale interrupts and tolerates a closed TTS socket", async () => {
    const { fetchMock } = createSfuFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    const transport = new SFUVoiceTransport({ config: CONFIG });

    expect(() => transport.interrupt("before-start")).not.toThrow();

    const socket = upgrade(transport, "/voice/tts/subscribe");
    await transport.start("call", () => {});
    expect(() => transport.interrupt("stale-call")).not.toThrow();

    const outgoing = nextSocketMessage(socket);
    transport.send("call", new Int16Array(480).buffer);
    await vi.advanceTimersByTimeAsync(20);
    await expect(outgoing).resolves.toBeInstanceOf(ArrayBuffer);

    socket.close(1000, "test");
    await Promise.resolve();
    expect(() => transport.interrupt("call")).not.toThrow();
  });
  it("persists browser-acknowledged playback checkpoints", async () => {
    let state: SFUVoiceState | null = null;
    const transport = new SFUVoiceTransport({
      config: CONFIG,
      loadState: async () => state,
      saveState: async (next) => {
        state = next;
      }
    });
    const response = await transport.handleHttpRequest(
      new Request("https://example.com/voice/playback-checkpoint/ack", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "checkpoint-1", text: "Played response" })
      })
    );

    expect(response?.status).toBe(200);
    expect(state?.playback?.acknowledged).toEqual({
      id: "checkpoint-1",
      text: "Played response"
    });
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

  it("closes each adapter once when call stop races stop-forwarding", async () => {
    const { calls, fetchMock } = createSfuFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    let state: SFUVoiceState | null = {
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
    };
    const transport = new SFUVoiceTransport({
      config: CONFIG,
      loadState: async () => state,
      saveState: async (nextState) => {
        state = nextState;
      }
    });
    upgrade(transport, "/voice/tts/subscribe");
    await transport.start("call", () => {});

    const [, stopForwarding] = await Promise.all([
      transport.stop("call"),
      transport.handleHttpRequest(
        new Request("https://example.com/voice/stt/stop-forwarding", {
          method: "POST"
        })
      )
    ]);

    expect(stopForwarding?.status).toBe(200);
    expect(
      calls.filter((call) => call.path.endsWith("/adapters/websocket/close"))
    ).toHaveLength(2);
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

  it("falls through unmatched routes and validates RTC route state", async () => {
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

    for (const body of [
      {},
      { sessionDescription: { sdp: "" }, microphoneMid: "0" },
      { sessionDescription: { sdp: "offer" } },
      { sessionDescription: { sdp: "offer" }, microphoneMid: "" }
    ]) {
      const connect = await transport.handleHttpRequest(
        new Request("https://example.com/voice/rtc/connect", {
          method: "POST",
          body: JSON.stringify(body)
        })
      );
      expect(connect?.status).toBe(400);
      await expect(connect?.text()).resolves.toBe(
        "Missing sessionDescription.sdp or microphoneMid"
      );
    }

    const pull = await transport.handleHttpRequest(
      new Request("https://example.com/voice/rtc/pull", { method: "POST" })
    );
    expect(pull?.status).toBe(400);
    await expect(pull?.text()).resolves.toBe("TTS not published yet");

    const renegotiate = await transport.handleHttpRequest(
      new Request("https://example.com/voice/rtc/renegotiate", {
        method: "POST",
        body: JSON.stringify({})
      })
    );
    expect(renegotiate?.status).toBe(400);
    await expect(renegotiate?.text()).resolves.toBe(
      "No RTC session to renegotiate. Call connect first."
    );

    const publishedOnly = new SFUVoiceTransport({
      config: CONFIG,
      loadState: async () => ({
        tts: {
          sessionId: "tts-session",
          adapterId: "tts-adapter",
          trackName: "tts-track"
        }
      })
    });
    const missingRtc = await publishedOnly.handleHttpRequest(
      new Request("https://example.com/voice/rtc/pull", { method: "POST" })
    );
    expect(missingRtc?.status).toBe(400);
    await expect(missingRtc?.text()).resolves.toBe(
      "RTC session not connected yet"
    );

    const connected = new SFUVoiceTransport({
      config: CONFIG,
      loadState: async () => ({
        stt: {
          sessionId: "rtc-session",
          trackName: "mic",
          callbackUrl: "wss://example.com/callback"
        }
      })
    });
    const missingSdp = await connected.handleHttpRequest(
      new Request("https://example.com/voice/rtc/renegotiate", {
        method: "POST",
        body: JSON.stringify({})
      })
    );
    expect(missingSdp?.status).toBe(400);
    await expect(missingSdp?.text()).resolves.toBe(
      "Missing sessionDescription.sdp"
    );
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

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ tracks: [{ errorCode: "TRACK_NOT_FOUND" }] })
      )
    );
    const pullTransport = new SFUVoiceTransport({
      config: CONFIG,
      loadState: async () => ({
        tts: {
          sessionId: "tts-session",
          adapterId: "tts-adapter",
          trackName: "tts-track"
        },
        stt: {
          sessionId: "rtc-session",
          trackName: "mic-track",
          callbackUrl: "wss://example.com/callback"
        }
      })
    });
    const pull = await pullTransport.handleHttpRequest(
      new Request("https://example.com/voice/rtc/pull", { method: "POST" })
    );
    expect(pull?.status).toBe(500);
    expect(await pull?.text()).toContain("TRACK_NOT_FOUND");
  });

  it("retries a pull while the primed TTS track propagates", async () => {
    let attempts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        attempts++;
        return Response.json({
          tracks:
            attempts < 3
              ? [{ errorCode: "empty_track_error" }]
              : [{ trackName: "tts-track" }]
        });
      })
    );
    const transport = new SFUVoiceTransport({
      config: CONFIG,
      loadState: async () => ({
        tts: {
          sessionId: "tts-session",
          adapterId: "tts-adapter",
          trackName: "tts-track"
        },
        stt: {
          sessionId: "rtc-session",
          trackName: "mic-track",
          callbackUrl: "wss://example.com/callback"
        }
      })
    });

    const pullPromise = transport.handleHttpRequest(
      new Request("https://example.com/voice/rtc/pull", { method: "POST" })
    );
    await vi.advanceTimersByTimeAsync(60);

    expect((await pullPromise)?.status).toBe(200);
    expect(attempts).toBe(3);
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
    await vi.advanceTimersByTimeAsync(15_000);
    const publish = await publishPromise;
    expect(publish?.status).toBe(500);
    expect(await publish?.text()).toContain("callback timeout after all retry");
    expect(loadState).toHaveBeenCalledTimes(1);
  });
  it("suspends media without teardown and resumes to rebind the connection", async () => {
    const { calls, fetchMock } = createSfuFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    let state: SFUVoiceState | null = {
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
    };
    const transport = new SFUVoiceTransport({
      config: CONFIG,
      loadState: async () => state,
      saveState: async (next) => {
        state = next;
      }
    });
    upgrade(transport, "/voice/tts/subscribe");
    await transport.start("call", () => {});

    transport.suspend("call");
    expect(
      calls.filter((call) => call.path.endsWith("/adapters/websocket/close"))
    ).toHaveLength(0);
    expect(state).not.toBeNull();
    expect(() => transport.send("call", new ArrayBuffer(0))).toThrow(
      "SFU voice transport connection is not active"
    );

    await transport.resume("call2", () => {});
    expect(() => transport.send("call2", new ArrayBuffer(0))).not.toThrow();
    expect(() => transport.send("call", new ArrayBuffer(0))).toThrow(
      "SFU voice transport connection is not active"
    );

    // Resume cancels the grace timer: nothing tears down after 30s.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(
      calls.filter((call) => call.path.endsWith("/adapters/websocket/close"))
    ).toHaveLength(0);
    expect(state).not.toBeNull();
  });

  it("tears down after the grace period expires while suspended", async () => {
    const { calls, fetchMock } = createSfuFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    let state: SFUVoiceState | null = {
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
    };
    const transport = new SFUVoiceTransport({
      config: CONFIG,
      loadState: async () => state,
      saveState: async (next) => {
        state = next;
      }
    });
    upgrade(transport, "/voice/tts/subscribe");
    await transport.start("call", () => {});

    transport.suspend("call");
    await vi.advanceTimersByTimeAsync(30_000);

    expect(
      calls.filter((call) => call.path.endsWith("/adapters/websocket/close"))
    ).toHaveLength(2);
    expect(state).toBeNull();
  });

  it("emits a silent keepalive frame when idle and stops after stop()", async () => {
    const { fetchMock } = createSfuFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    const transport = new SFUVoiceTransport({ config: CONFIG });
    const socket = upgrade(transport, "/voice/tts/subscribe");
    await transport.start("call", () => {});

    const frames: ArrayBuffer[] = [];
    socket.addEventListener("message", (event) => {
      frames.push(event.data as ArrayBuffer);
    });

    await vi.advanceTimersByTimeAsync(20_000);
    expect(frames).toHaveLength(1);
    const payload = extractPayloadFromProtobuf(frames[0]);
    expect(payload?.byteLength).toBe(3840);
    expect(new Set(new Int16Array(payload!.buffer))).toEqual(new Set([0]));

    await transport.stop("call");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(frames).toHaveLength(1);
  });

  it("fails fast on resume when the grace window already expired", async () => {
    const transport = new SFUVoiceTransport({ config: CONFIG });

    await expect(transport.resume("call", () => {})).rejects.toThrow(
      "SFU voice transport has no suspended session to resume"
    );
    expect(() => transport.send("call", new ArrayBuffer(0))).toThrow(
      "SFU voice transport connection is not active"
    );
  });
});

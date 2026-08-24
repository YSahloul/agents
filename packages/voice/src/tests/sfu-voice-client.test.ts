import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SFUVoiceAudioInput } from "../sfu-voice-client";

declare global {
  interface PromiseConstructor {
    withResolvers<T>(): {
      promise: Promise<T>;
      resolve: (value: T | PromiseLike<T>) => void;
      reject: (reason?: unknown) => void;
    };
  }
}

class FakeTrack {
  enabled = true;
  stopped = false;
  clones: FakeTrack[] = [];
  settings: MediaTrackSettings = {
    autoGainControl: true,
    channelCount: 1,
    echoCancellation: true,
    noiseSuppression: true,
    sampleRate: 48000
  };

  getSettings(): MediaTrackSettings {
    return this.settings;
  }
  clone(): MediaStreamTrack {
    const clone = new FakeTrack();
    clone.settings = { ...this.settings };
    this.clones.push(clone);
    return clone as unknown as MediaStreamTrack;
  }

  stop(): void {
    this.stopped = true;
  }
}

class FakeStream {
  readonly track: FakeTrack | null;

  constructor(hasAudio = true) {
    this.track = hasAudio ? new FakeTrack() : null;
  }

  getTracks(): MediaStreamTrack[] {
    return this.track ? [this.track as unknown as MediaStreamTrack] : [];
  }

  getAudioTracks(): MediaStreamTrack[] {
    return this.getTracks();
  }
}

class FakeAudioElement {
  autoplay = false;
  style = { display: "" };
  srcObject: MediaStream | null = null;
  played = 0;
  paused = false;
  removed = false;
  sinkIds: string[] = [];

  async play(): Promise<void> {
    this.played++;
  }

  pause(): void {
    this.paused = true;
  }

  remove(): void {
    this.removed = true;
  }

  async setSinkId(deviceId: string): Promise<void> {
    this.sinkIds.push(deviceId);
  }
}

class FakeAnalyser {
  fftSize = 0;
  level = 0.5;

  getFloatTimeDomainData(samples: Float32Array): void {
    samples.fill(this.level);
  }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  readonly analyser = new FakeAnalyser();
  readonly connections: unknown[] = [];
  resumed = false;
  closed = false;

  constructor() {
    FakeAudioContext.instances.push(this);
  }

  async resume(): Promise<void> {
    this.resumed = true;
  }

  createAnalyser(): AnalyserNode {
    return this.analyser as unknown as AnalyserNode;
  }

  createMediaStreamSource(): MediaStreamAudioSourceNode {
    return {
      connect: (node: unknown) => this.connections.push(node)
    } as unknown as MediaStreamAudioSourceNode;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

type TransceiverCall = {
  track: MediaStreamTrack;
  direction?: RTCRtpTransceiverDirection;
  streams?: MediaStream[];
};

class FakePeerConnection {
  static instances: FakePeerConnection[] = [];
  static deferFirstOffer = false;
  static transceiverMid: string | null = "0";
  readonly index: number;
  readonly configuration: RTCConfiguration;
  connectionState: RTCPeerConnectionState = "new";
  ontrack: ((event: RTCTrackEvent) => void) | null = null;
  closed = false;
  transceiverCalls: TransceiverCall[] = [];
  localDescriptions: RTCSessionDescriptionInit[] = [];
  remoteDescriptions: RTCSessionDescriptionInit[] = [];
  #listeners = new Set<() => void>();
  #resolveOffer: ((offer: RTCSessionDescriptionInit) => void) | null = null;

  constructor(configuration: RTCConfiguration) {
    this.index = FakePeerConnection.instances.length;
    this.configuration = configuration;
    FakePeerConnection.instances.push(this);
  }

  get connectionListenerCount(): number {
    return this.#listeners.size;
  }

  addTransceiver(
    track: MediaStreamTrack,
    init?: RTCRtpTransceiverInit
  ): RTCRtpTransceiver {
    this.transceiverCalls.push({
      track,
      direction: init?.direction,
      streams: init?.streams
    });
    return { mid: FakePeerConnection.transceiverMid } as RTCRtpTransceiver;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    const offer = { type: "offer" as RTCSdpType, sdp: `offer-${this.index}` };
    if (this.index !== 0 || !FakePeerConnection.deferFirstOffer) return offer;
    const { promise, resolve } =
      Promise.withResolvers<RTCSessionDescriptionInit>();
    this.#resolveOffer = resolve;
    return promise;
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: "answer", sdp: `answer-${this.index}` };
  }

  resolveOffer(): void {
    this.#resolveOffer?.({ type: "offer", sdp: `offer-${this.index}` });
    this.#resolveOffer = null;
  }

  async setLocalDescription(
    description: RTCSessionDescriptionInit
  ): Promise<void> {
    this.localDescriptions.push(description);
  }

  async setRemoteDescription(
    description: RTCSessionDescriptionInit
  ): Promise<void> {
    this.remoteDescriptions.push(description);
  }

  addEventListener(type: string, listener: () => void): void {
    if (type === "connectionstatechange") this.#listeners.add(listener);
  }

  removeEventListener(type: string, listener: () => void): void {
    if (type === "connectionstatechange") this.#listeners.delete(listener);
  }

  close(): void {
    this.closed = true;
    this.connectionState = "closed";
    this.#dispatch();
  }

  connect(): void {
    this.connectionState = "connected";
    this.#dispatch();
  }

  fail(): void {
    this.connectionState = "failed";
    this.#dispatch();
  }

  emitTrack(stream: MediaStream): void {
    this.ontrack?.({ streams: [stream] } as unknown as RTCTrackEvent);
  }

  #dispatch(): void {
    for (const listener of [...this.#listeners]) listener();
  }
}

let stream: FakeStream;
let audio: FakeAudioElement;
let requests: string[];
let requestBodies: unknown[];
let requestHeaders: Headers[];
let failOperation: string | null;
let pullResponse: unknown;
let stopForwardingGate: {
  promise: Promise<void>;
  resolve: () => void;
} | null;
let animationFrames: Array<FrameRequestCallback | null>;
const originalMediaDevices = Object.getOwnPropertyDescriptor(
  navigator,
  "mediaDevices"
);

function operation(input: RequestInfo | URL): string {
  return new URL(String(input), "https://example.com").pathname
    .split("/voice/")
    .at(-1)!;
}

function mockResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body))
  } as Response;
}

async function waitFor(
  condition: () => boolean,
  message: string
): Promise<void> {
  for (let i = 0; i < 30; i++) {
    if (condition()) return;
    await Promise.resolve();
  }
  throw new Error(message);
}

async function waitForPeer(): Promise<FakePeerConnection> {
  await waitFor(
    () => FakePeerConnection.instances.length === 1,
    "Expected one peer connection"
  );
  const peer = FakePeerConnection.instances[0];
  await waitFor(
    () => peer.connectionListenerCount > 0,
    "Expected SFU connection listener"
  );
  return peer;
}

beforeEach(() => {
  stream = new FakeStream();
  audio = new FakeAudioElement();
  requests = [];
  requestBodies = [];
  requestHeaders = [];
  failOperation = null;
  stopForwardingGate = null;
  pullResponse = {
    requiresImmediateRenegotiation: true,
    sessionDescription: { type: "offer", sdp: "rtc-pull-offer" },
    tracks: [{ trackName: "tts-track" }]
  };
  animationFrames = [];
  FakePeerConnection.instances = [];
  FakePeerConnection.deferFirstOffer = false;
  FakePeerConnection.transceiverMid = "0";
  FakeAudioContext.instances = [];

  vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
  vi.stubGlobal("AudioContext", FakeAudioContext);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: vi.fn(async () => stream as unknown as MediaStream)
    }
  });
  vi.stubGlobal("document", {
    body: { appendChild() {} },
    createElement: () => audio
  });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    animationFrames.push(callback);
    return animationFrames.length - 1;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    animationFrames[id] = null;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const name = operation(input);
      requests.push(name);
      requestHeaders.push(new Headers(init?.headers));
      requestBodies.push(
        typeof init?.body === "string" ? JSON.parse(init.body) : undefined
      );
      if (name === "stt/stop-forwarding" && stopForwardingGate) {
        await stopForwardingGate.promise;
      }
      if (name === failOperation) return mockResponse("failed", 500);
      if (name === "rtc/connect") {
        return mockResponse({
          sessionDescription: { type: "answer", sdp: "rtc-connect-answer" }
        });
      }
      if (name === "rtc/pull") return mockResponse(pullResponse);
      if (name === "rtc/renegotiate") return mockResponse({});
      return mockResponse("ok");
    })
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (originalMediaDevices) {
    Object.defineProperty(navigator, "mediaDevices", originalMediaDevices);
  } else {
    Reflect.deleteProperty(navigator, "mediaDevices");
  }
});

describe("SFUVoiceAudioInput", () => {
  it("reports microphone and remote playback levels", async () => {
    const playbackLevels: number[] = [];
    const input = new SFUVoiceAudioInput({
      endpoint: "/agent/alice/voice/",
      headers: { Authorization: "Bearer mobile-token" },
      onPlaybackAudioLevel: (level) => playbackLevels.push(level)
    });
    const levels: number[] = [];
    const audioData = vi.fn();
    input.onAudioLevel = (level) => levels.push(level);
    input.onAudioData = audioData;

    const start = input.start();
    const peer = await waitForPeer();

    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({
      audio: {
        sampleRate: { ideal: 48000 },
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });
    expect(FakePeerConnection.instances).toHaveLength(1);
    expect(peer.transceiverCalls).toEqual([
      {
        track: stream.track,
        direction: "sendonly",
        streams: [stream]
      }
    ]);
    const context = FakeAudioContext.instances[0];
    expect(context.resumed).toBe(true);
    expect(context.connections).toEqual([context.analyser]);
    expect(requests).toEqual(["tts/publish", "rtc/connect"]);
    expect(requestBodies[1]).toEqual({
      sessionDescription: { type: "offer", sdp: "offer-0" },
      microphoneMid: "0"
    });

    peer.connect();
    await start;

    expect(requests).toEqual([
      "tts/publish",
      "rtc/connect",
      "rtc/pull",
      "rtc/renegotiate",
      "stt/start-forwarding"
    ]);
    expect(
      requestHeaders.every(
        (headers) => headers.get("Authorization") === "Bearer mobile-token"
      )
    ).toBe(true);
    expect(peer.remoteDescriptions).toEqual([
      { type: "answer", sdp: "rtc-connect-answer" },
      { type: "offer", sdp: "rtc-pull-offer" }
    ]);
    expect(peer.localDescriptions).toEqual([
      { type: "offer", sdp: "offer-0" },
      { type: "answer", sdp: "answer-0" }
    ]);
    expect(requestBodies[3]).toEqual({
      sessionDescription: { type: "answer", sdp: "answer-0" }
    });

    peer.emitTrack(stream as unknown as MediaStream);
    await Promise.resolve();
    expect(audio.srcObject).toBe(stream);
    expect(audio.played).toBe(1);

    animationFrames.find((callback) => callback)?.(0);
    expect(levels.at(-1)).toBeCloseTo(0.5);
    expect(playbackLevels.at(-1)).toBeCloseTo(0.5);
    expect(audioData).not.toHaveBeenCalled();

    input.setMuted(true);
    expect(stream.track?.enabled).toBe(false);
    input.setMuted(false);
    expect(stream.track?.enabled).toBe(true);
    await input.setOutputDevice("speaker-1");
    expect(audio.sinkIds).toEqual(["speaker-1"]);

    input.stop();
    expect(peer.closed).toBe(true);
    expect(stream.track?.stopped).toBe(true);
    expect(context.closed).toBe(true);
    expect(playbackLevels.at(-1)).toBe(0);
    expect(audio.paused).toBe(true);
    expect(audio.removed).toBe(true);
    expect(requests.at(-1)).toBe("stt/stop-forwarding");
  });

  it("accepts browser capture without reported echo cancellation", async () => {
    if (stream.track) stream.track.settings.echoCancellation = false;
    const input = new SFUVoiceAudioInput({ endpoint: "/voice" });

    const start = input.start();
    const peer = await waitForPeer();
    peer.connect();
    await start;

    expect(FakePeerConnection.instances).toHaveLength(1);
  });

  it("waits for forwarding teardown before restarting", async () => {
    const input = new SFUVoiceAudioInput({ endpoint: "/voice" });
    const firstStart = input.start();
    const firstPeer = await waitForPeer();
    firstPeer.connect();
    await firstStart;

    stopForwardingGate = Promise.withResolvers<void>();
    input.stop();
    const restart = input.start();

    await waitFor(
      () => requests.at(-1) === "stt/stop-forwarding",
      "Expected forwarding teardown"
    );
    expect(
      requests.filter((request) => request === "tts/publish")
    ).toHaveLength(1);

    stopForwardingGate.resolve();
    await waitFor(
      () => FakePeerConnection.instances.length === 2,
      "Expected restarted peer connection"
    );
    const secondPeer = FakePeerConnection.instances[1];
    secondPeer.connect();
    await restart;

    const stopIndex = requests.indexOf("stt/stop-forwarding");
    const secondPublishIndex = requests.lastIndexOf("tts/publish");
    expect(stopIndex).toBeLessThan(secondPublishIndex);
    input.stop();
  });

  it("uses and stops a supplied platform microphone", async () => {
    const stop = vi.fn();
    const captureMicrophone = vi.fn(async () => ({
      stream: stream as unknown as MediaStream,
      stop
    }));
    const input = new SFUVoiceAudioInput({
      endpoint: "/voice",
      captureMicrophone
    });

    const start = input.start();
    const peer = await waitForPeer();
    peer.connect();
    await start;
    input.stop();
    await Promise.resolve();

    expect(captureMicrophone).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("cleans a late capture without replacing the current microphone", async () => {
    const lateStream = new FakeStream();
    const currentStream = new FakeStream();
    const lateStop = vi.fn();
    const currentStop = vi.fn();
    const { promise: lateCapture, resolve: resolveLate } =
      Promise.withResolvers<{
        stream: MediaStream;
        stop: () => void;
      }>();
    const captureMicrophone = vi
      .fn<() => Promise<{ stream: MediaStream; stop: () => void }>>()
      .mockReturnValueOnce(lateCapture)
      .mockResolvedValueOnce({
        stream: currentStream as unknown as MediaStream,
        stop: currentStop
      });
    const input = new SFUVoiceAudioInput({
      endpoint: "/voice",
      captureMicrophone
    });

    const firstStart = input.start();
    await waitFor(
      () => captureMicrophone.mock.calls.length === 1,
      "Expected deferred capture"
    );
    const secondStart = input.start();
    const peer = await waitForPeer();
    peer.connect();
    await secondStart;

    resolveLate({
      stream: lateStream as unknown as MediaStream,
      stop: lateStop
    });
    await firstStart;

    expect(lateStream.track?.stopped).toBe(true);
    expect(lateStop).toHaveBeenCalledOnce();
    expect(currentStream.track?.stopped).toBe(false);
    expect(currentStop).not.toHaveBeenCalled();
    input.setMuted(true);
    expect(currentStream.track?.enabled).toBe(false);

    input.stop();
    await Promise.resolve();
    expect(currentStop).toHaveBeenCalledOnce();
  });

  it("cleans capture when the microphone stream has no audio track", async () => {
    const emptyStream = new FakeStream(false);
    const stop = vi.fn();
    const input = new SFUVoiceAudioInput({
      endpoint: "/voice",
      captureMicrophone: async () => ({
        stream: emptyStream as unknown as MediaStream,
        stop
      })
    });

    await expect(input.start()).rejects.toThrow(
      "Microphone stream has no audio track"
    );
    await Promise.resolve();

    expect(stop).toHaveBeenCalledOnce();
    expect(FakePeerConnection.instances).toHaveLength(0);
    expect(requests.at(-1)).toBe("stt/stop-forwarding");
  });

  it("rolls back a failed start", async () => {
    failOperation = "rtc/connect";
    const input = new SFUVoiceAudioInput({ endpoint: "/voice" });
    input.onAudioLevel = () => {};

    await expect(input.start()).rejects.toThrow("rtc/connect failed (500)");
    expect(FakePeerConnection.instances[0].closed).toBe(true);
    expect(stream.track?.stopped).toBe(true);
    expect(audio.removed).toBe(true);
    expect(input.onAudioLevel).toBeNull();
    expect(requests.at(-1)).toBe("stt/stop-forwarding");
  });

  it("does not revive a start stopped during an awaited offer", async () => {
    FakePeerConnection.deferFirstOffer = true;
    const input = new SFUVoiceAudioInput({ endpoint: "/voice" });
    const start = input.start();
    await waitFor(
      () => FakePeerConnection.instances.length === 1,
      "Expected peer connection"
    );

    input.stop();
    input.stop();
    FakePeerConnection.instances[0].resolveOffer();
    await expect(start).resolves.toBeUndefined();

    expect(FakePeerConnection.instances[0].closed).toBe(true);
    expect(
      requests.filter((name) => name === "stt/stop-forwarding")
    ).toHaveLength(1);
    expect(requests).not.toContain("rtc/connect");
  });

  it("rolls back when the SFU connection fails", async () => {
    const input = new SFUVoiceAudioInput({ endpoint: "/voice" });
    const start = input.start();
    const rejected = expect(start).rejects.toThrow(
      "SFU WebRTC connection failed"
    );
    const peer = await waitForPeer();
    peer.fail();

    await rejected;
    expect(peer.closed).toBe(true);
    expect(stream.track?.stopped).toBe(true);
  });

  it("times out the SFU connection after 15 seconds", async () => {
    vi.useFakeTimers();
    const input = new SFUVoiceAudioInput({ endpoint: "/voice" });
    const start = input.start();
    const rejected = expect(start).rejects.toThrow(
      "SFU WebRTC connection timed out"
    );
    await waitForPeer();
    await vi.advanceTimersByTimeAsync(15_000);

    await rejected;
    expect(FakePeerConnection.instances[0].closed).toBe(true);
  });

  it.each([
    [
      "missing renegotiation flag",
      { sessionDescription: { type: "offer", sdp: "pull-offer" } }
    ],
    [
      "non-offer description",
      {
        requiresImmediateRenegotiation: true,
        sessionDescription: { type: "answer", sdp: "pull-answer" }
      }
    ]
  ])("rejects a pull response with %s", async (_name, response) => {
    pullResponse = response;
    const input = new SFUVoiceAudioInput({ endpoint: "/voice" });
    const start = input.start();
    const rejected = expect(start).rejects.toThrow(
      "RTC pull response missing required offer sessionDescription.sdp"
    );
    const peer = await waitForPeer();
    peer.connect();

    await rejected;
    expect(requests).not.toContain("rtc/renegotiate");
    expect(requests).not.toContain("stt/start-forwarding");
    expect(peer.closed).toBe(true);
  });

  it("rejects a missing microphone transceiver mid", async () => {
    FakePeerConnection.transceiverMid = null;
    const input = new SFUVoiceAudioInput({ endpoint: "/voice" });

    await expect(input.start()).rejects.toThrow(
      "Microphone transceiver missing mid after local description"
    );
    expect(requests).not.toContain("rtc/connect");
  });

  it("throws NotSupportedError only for non-default sinks without setSinkId", async () => {
    Object.defineProperty(audio, "setSinkId", { value: undefined });
    const input = new SFUVoiceAudioInput({ endpoint: "/voice" });
    const start = input.start();
    const peer = await waitForPeer();
    peer.connect();
    await start;

    await expect(input.setOutputDevice("default")).resolves.toBeUndefined();
    await expect(input.setOutputDevice("speaker-1")).rejects.toMatchObject({
      name: "NotSupportedError"
    });
    input.stop();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SFUVoiceAudioInput } from "../sfu-voice-client";

class FakeTrack {
  enabled = true;
  stopped = false;

  stop(): void {
    this.stopped = true;
  }
}

class FakeStream {
  readonly track = new FakeTrack();

  getTracks(): MediaStreamTrack[] {
    return [this.track as unknown as MediaStreamTrack];
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

  getFloatTimeDomainData(samples: Float32Array): void {
    samples.fill(0.5);
  }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  readonly analyser = new FakeAnalyser();
  readonly destination = new FakeStream();
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

  createMediaStreamDestination(): MediaStreamAudioDestinationNode {
    return {
      stream: this.destination as unknown as MediaStream
    } as MediaStreamAudioDestinationNode;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class FakePeerConnection {
  static instances: FakePeerConnection[] = [];
  static deferFirstOffer = false;
  readonly index: number;
  readonly configuration: RTCConfiguration;
  connectionState: RTCPeerConnectionState = "new";
  ontrack: ((event: RTCTrackEvent) => void) | null = null;
  closed = false;
  transceiverDirection: RTCRtpTransceiverDirection | null = null;
  tracks: MediaStreamTrack[] = [];
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
    _trackOrKind: string,
    init?: RTCRtpTransceiverInit
  ): RTCRtpTransceiver {
    this.transceiverDirection = init?.direction ?? null;
    return {} as RTCRtpTransceiver;
  }

  addTrack(track: MediaStreamTrack): RTCRtpSender {
    this.tracks.push(track);
    return {} as RTCRtpSender;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    const offer = { type: "offer" as RTCSdpType, sdp: `offer-${this.index}` };
    if (this.index !== 0 || !FakePeerConnection.deferFirstOffer) return offer;
    return new Promise((resolve) => {
      this.#resolveOffer = resolve;
    });
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
let requestHeaders: Headers[];
let failOperation: string | null;
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

async function waitForPeers(count: number): Promise<void> {
  await waitFor(
    () => FakePeerConnection.instances.length >= count,
    `Expected ${count} peer connections`
  );
}

async function waitForMicrophonePeer(): Promise<void> {
  await waitForPeers(2);
  await waitFor(
    () => FakePeerConnection.instances[1].connectionListenerCount > 0,
    "Expected microphone connection listener"
  );
}

beforeEach(() => {
  stream = new FakeStream();
  audio = new FakeAudioElement();
  requests = [];
  requestHeaders = [];
  failOperation = null;
  animationFrames = [];
  FakePeerConnection.instances = [];
  FakePeerConnection.deferFirstOffer = false;
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
      if (name === failOperation) return mockResponse("failed", 500);
      if (name === "tts/connect") {
        return mockResponse({ requiresImmediateRenegotiation: true });
      }
      if (name === "tts/renegotiate" || name === "stt/connect") {
        return mockResponse({
          sessionDescription: { type: "answer", sdp: `${name}-answer` }
        });
      }
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
  it("negotiates in order, plays remote audio, reports RMS, mutes, and selects a sink", async () => {
    const input = new SFUVoiceAudioInput({
      endpoint: "/agent/alice/voice/",
      headers: { Authorization: "Bearer mobile-token" }
    });
    const levels: number[] = [];
    const audioData = vi.fn();
    input.onAudioLevel = (level) => levels.push(level);
    input.onAudioData = audioData;

    const start = input.start();
    await waitForMicrophonePeer();
    expect(FakePeerConnection.instances[0].transceiverDirection).toBe(
      "recvonly"
    );
    expect(FakePeerConnection.instances[1].tracks).toHaveLength(1);
    const microphoneContext = FakeAudioContext.instances[0];
    expect(microphoneContext.resumed).toBe(true);
    expect(microphoneContext.connections[0]).toBe(microphoneContext.analyser);
    expect(
      (microphoneContext.connections[1] as MediaStreamAudioDestinationNode)
        .stream
    ).toBe(microphoneContext.destination);
    expect(FakePeerConnection.instances[1].tracks[0]).toBe(
      microphoneContext.destination.track
    );
    expect(FakePeerConnection.instances[1].tracks[0]).not.toBe(stream.track);
    expect(requests).toEqual([
      "tts/publish",
      "tts/connect",
      "tts/renegotiate",
      "stt/connect"
    ]);
    expect(
      requestHeaders.every(
        (headers) => headers.get("Authorization") === "Bearer mobile-token"
      )
    ).toBe(true);

    FakePeerConnection.instances[1].connect();
    await start;
    expect(requests).toEqual([
      "tts/publish",
      "tts/connect",
      "tts/renegotiate",
      "stt/connect",
      "stt/start-forwarding"
    ]);

    FakePeerConnection.instances[0].emitTrack(stream as unknown as MediaStream);
    await Promise.resolve();
    expect(audio.srcObject).toBe(stream);
    expect(audio.played).toBe(1);

    animationFrames.find((callback) => callback)?.(0);
    expect(levels.at(-1)).toBeCloseTo(0.5);
    expect(audioData).not.toHaveBeenCalled();

    input.setMuted(true);
    expect(stream.track.enabled).toBe(false);
    input.setMuted(false);
    expect(stream.track.enabled).toBe(true);
    await input.setOutputDevice("speaker-1");
    expect(audio.sinkIds).toEqual(["speaker-1"]);

    input.stop();
    expect(FakePeerConnection.instances.every((peer) => peer.closed)).toBe(
      true
    );
    expect(stream.track.stopped).toBe(true);
    expect(microphoneContext.destination.track.stopped).toBe(true);
    expect(microphoneContext.closed).toBe(true);
    expect(audio.paused).toBe(true);
    expect(audio.removed).toBe(true);
    expect(requests.at(-1)).toBe("stt/stop-forwarding");
  });

  it("uses and stops a supplied platform microphone", async () => {
    const stop = vi.fn();
    const captureMicrophone = vi.fn(async () => ({ stream, stop }));
    const input = new SFUVoiceAudioInput({
      endpoint: "/voice",
      captureMicrophone
    });

    const start = input.start();
    await waitForMicrophonePeer();
    FakePeerConnection.instances[1].connect();
    await start;
    input.stop();
    await Promise.resolve();

    expect(captureMicrophone).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("rolls back a failed start", async () => {
    failOperation = "tts/connect";
    const input = new SFUVoiceAudioInput({ endpoint: "/voice" });
    input.onAudioLevel = () => {};

    await expect(input.start()).rejects.toThrow("tts/connect failed (500)");
    expect(FakePeerConnection.instances[0].closed).toBe(true);
    expect(audio.removed).toBe(true);
    expect(input.onAudioLevel).toBeNull();
    expect(requests.at(-1)).toBe("stt/stop-forwarding");
  });

  it("does not revive a start stopped during an awaited offer", async () => {
    FakePeerConnection.deferFirstOffer = true;
    const input = new SFUVoiceAudioInput({ endpoint: "/voice" });
    const start = input.start();
    await waitForPeers(1);

    input.stop();
    input.stop();
    FakePeerConnection.instances[0].resolveOffer();
    await expect(start).resolves.toBeUndefined();

    expect(FakePeerConnection.instances[0].closed).toBe(true);
    expect(
      requests.filter((name) => name === "stt/stop-forwarding")
    ).toHaveLength(1);
    expect(requests).not.toContain("tts/connect");
  });

  it("rolls back when the microphone connection fails", async () => {
    const input = new SFUVoiceAudioInput({ endpoint: "/voice" });
    const start = input.start();
    const rejected = expect(start).rejects.toThrow(
      "Microphone WebRTC connection failed"
    );
    await waitForMicrophonePeer();
    FakePeerConnection.instances[1].fail();

    await rejected;
    expect(FakePeerConnection.instances.every((peer) => peer.closed)).toBe(
      true
    );
    expect(stream.track.stopped).toBe(true);
  });

  it("times out a microphone connection after 15 seconds", async () => {
    vi.useFakeTimers();
    const input = new SFUVoiceAudioInput({ endpoint: "/voice" });
    const start = input.start();
    const rejected = expect(start).rejects.toThrow(
      "Microphone WebRTC connection timed out"
    );
    await waitForMicrophonePeer();
    await vi.advanceTimersByTimeAsync(15_000);

    await rejected;
    expect(FakePeerConnection.instances.every((peer) => peer.closed)).toBe(
      true
    );
  });

  it("throws NotSupportedError only for non-default sinks without setSinkId", async () => {
    Object.defineProperty(audio, "setSinkId", { value: undefined });
    const input = new SFUVoiceAudioInput({ endpoint: "/voice" });
    const start = input.start();
    await waitForMicrophonePeer();
    FakePeerConnection.instances[1].connect();
    await start;

    await expect(input.setOutputDevice("default")).resolves.toBeUndefined();
    await expect(input.setOutputDevice("speaker-1")).rejects.toMatchObject({
      name: "NotSupportedError"
    });
    input.stop();
  });
});

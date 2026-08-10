import type { VoiceAudioInput } from "./types";

export interface SFUVoiceAudioInputOptions {
  /** Agent instance route plus the SFU route prefix, for example `/agents/voice/alice/voice`. */
  endpoint: string;
  iceServers?: RTCIceServer[];
  /** Headers sent with SFU HTTP requests, such as Authorization for native clients. */
  headers?: HeadersInit;
  /** Supplies a platform microphone stream when getUserMedia is not the capture source. */
  captureMicrophone?: () => Promise<{
    stream: MediaStream;
    stop?: () => void | Promise<void>;
  }>;
}

type SFUResponse = {
  sessionDescription?: unknown;
  requiresImmediateRenegotiation?: unknown;
};

type AudioElementWithSinkId = HTMLAudioElement & {
  setSinkId?(deviceId: string): Promise<void>;
};

class StaleStart extends Error {}

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.cloudflare.com:3478" }
];

export class SFUVoiceAudioInput implements VoiceAudioInput {
  readonly handlesPlayback = true;
  onAudioLevel: ((rms: number) => void) | null = null;
  onAudioData: ((pcm: ArrayBuffer) => void) | null = null;

  readonly #endpoint: string;
  readonly #iceServers: RTCIceServer[];
  readonly #headers: Headers;
  readonly #captureMicrophone: SFUVoiceAudioInputOptions["captureMicrophone"];
  readonly #jsonHeaders: Headers;
  #generation = 0;
  #listenerPeer: RTCPeerConnection | null = null;
  #microphonePeer: RTCPeerConnection | null = null;
  #microphoneStream: MediaStream | null = null;
  #stopMicrophone: (() => void | Promise<void>) | null = null;
  #publishedStream: MediaStream | null = null;
  #audioElement: HTMLAudioElement | null = null;
  #analyserContext: AudioContext | null = null;
  #animationFrame: number | null = null;
  #shouldStopForwarding = false;

  constructor(options: SFUVoiceAudioInputOptions) {
    this.#endpoint = options.endpoint.replace(/\/$/, "");
    this.#iceServers = options.iceServers ?? DEFAULT_ICE_SERVERS;
    this.#captureMicrophone = options.captureMicrophone;
    this.#headers = new Headers(options.headers);
    this.#jsonHeaders = new Headers(this.#headers);
    this.#jsonHeaders.set("Content-Type", "application/json");
  }

  async start(): Promise<void> {
    const generation = ++this.#generation;
    this.#teardown(this.#shouldStopForwarding, false);
    this.#shouldStopForwarding = true;

    try {
      await this.#post("tts/publish");
      this.#assertCurrent(generation);

      const listenerPeer = new RTCPeerConnection({
        iceServers: this.#iceServers
      });
      listenerPeer.addTransceiver("audio", { direction: "recvonly" });
      this.#listenerPeer = listenerPeer;

      const audio = document.createElement("audio");
      audio.autoplay = true;
      audio.style.display = "none";
      document.body.appendChild(audio);
      this.#audioElement = audio;
      listenerPeer.ontrack = (event) => {
        if (
          generation !== this.#generation ||
          this.#listenerPeer !== listenerPeer
        ) {
          return;
        }
        audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
        void audio.play().catch((error: unknown) => {
          console.warn("[SFUVoiceAudioInput] Audio playback failed:", error);
        });
      };

      const listenerOffer = await listenerPeer.createOffer();
      this.#assertCurrent(generation);
      await listenerPeer.setLocalDescription(listenerOffer);
      this.#assertCurrent(generation);
      const ttsAnswer = await this.#connectTts(listenerPeer, listenerOffer);
      this.#assertCurrent(generation);
      await listenerPeer.setRemoteDescription(ttsAnswer);
      this.#assertCurrent(generation);

      const capture = this.#captureMicrophone
        ? await this.#captureMicrophone()
        : {
            stream: await navigator.mediaDevices.getUserMedia({
              audio: {
                sampleRate: 48000,
                channelCount: 2,
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
              }
            })
          };
      const microphoneStream = capture.stream;
      if (generation !== this.#generation) {
        microphoneStream.getTracks().forEach((track) => track.stop());
        await capture.stop?.();
        throw new StaleStart();
      }
      this.#stopMicrophone = capture.stop ?? null;
      this.#microphoneStream = microphoneStream;
      const publishedStream = await this.#createMicrophoneBridge(
        microphoneStream,
        generation
      );
      this.#publishedStream = publishedStream;

      const microphonePeer = new RTCPeerConnection({
        iceServers: this.#iceServers
      });
      this.#microphonePeer = microphonePeer;
      publishedStream
        .getTracks()
        .forEach((track) => microphonePeer.addTrack(track, publishedStream));

      const microphoneOffer = await microphonePeer.createOffer();
      this.#assertCurrent(generation);
      await microphonePeer.setLocalDescription(microphoneOffer);
      this.#assertCurrent(generation);
      const sttAnswer = await this.#connectStt(microphoneOffer);
      this.#assertCurrent(generation);
      await microphonePeer.setRemoteDescription(sttAnswer);
      this.#assertCurrent(generation);
      await this.#waitForConnected(microphonePeer, generation);
      this.#assertCurrent(generation);
      await this.#post("stt/start-forwarding");
      this.#assertCurrent(generation);
    } catch (error) {
      if (error instanceof StaleStart || generation !== this.#generation)
        return;
      this.stop();
      throw error;
    }
  }

  stop(): void {
    this.#generation++;
    this.#teardown(this.#shouldStopForwarding, true);
  }

  #teardown(stopForwarding: boolean, clearCallbacks: boolean): void {
    this.#shouldStopForwarding = false;
    if (stopForwarding) {
      void this.#post("stt/stop-forwarding").catch(() => {});
    }
    if (this.#animationFrame !== null) {
      cancelAnimationFrame(this.#animationFrame);
      this.#animationFrame = null;
    }
    this.#listenerPeer?.close();
    this.#listenerPeer = null;
    this.#microphonePeer?.close();
    this.#microphonePeer = null;
    this.#microphoneStream?.getTracks().forEach((track) => track.stop());
    this.#microphoneStream = null;
    const stopMicrophone = this.#stopMicrophone;
    this.#stopMicrophone = null;
    void Promise.resolve(stopMicrophone?.()).catch(() => {});
    this.#publishedStream?.getTracks().forEach((track) => track.stop());
    this.#publishedStream = null;
    void this.#analyserContext?.close().catch(() => {});
    this.#analyserContext = null;
    if (this.#audioElement) {
      this.#audioElement.pause();
      this.#audioElement.srcObject = null;
      this.#audioElement.remove();
      this.#audioElement = null;
    }
    if (clearCallbacks) {
      this.onAudioLevel = null;
      this.onAudioData = null;
    }
  }

  setMuted(muted: boolean): void {
    this.#microphoneStream
      ?.getTracks()
      .forEach((track) => (track.enabled = !muted));
  }

  async setOutputDevice(deviceId: string): Promise<void> {
    const audio = this.#audioElement as AudioElementWithSinkId | null;
    if (!audio) return;
    if (!audio.setSinkId) {
      if (deviceId === "default") return;
      throw new DOMException(
        "Audio output selection is not supported by this browser.",
        "NotSupportedError"
      );
    }
    await audio.setSinkId(deviceId);
  }

  async #connectTts(
    listenerPeer: RTCPeerConnection,
    offer: RTCSessionDescriptionInit
  ): Promise<RTCSessionDescriptionInit> {
    const response = await this.#postJSON("tts/connect", {
      sessionDescription: offer
    });
    const description = this.#sessionDescription(response);
    if (description) return description;
    if (response.requiresImmediateRenegotiation !== true) {
      throw new Error("TTS connect response missing sessionDescription.sdp");
    }

    const reoffer = await listenerPeer.createOffer();
    await listenerPeer.setLocalDescription(reoffer);
    return this.#requireSessionDescription(
      await this.#postJSON("tts/renegotiate", {
        sessionDescription: reoffer
      }),
      "TTS renegotiate"
    );
  }

  async #connectStt(
    offer: RTCSessionDescriptionInit
  ): Promise<RTCSessionDescriptionInit> {
    return this.#requireSessionDescription(
      await this.#postJSON("stt/connect", { sessionDescription: offer }),
      "STT connect"
    );
  }

  async #post(operation: string): Promise<Response> {
    const response = await fetch(`${this.#endpoint}/${operation}`, {
      method: "POST",
      headers: this.#headers
    });
    if (!response.ok) {
      throw new Error(
        `${operation} failed (${response.status}): ${await response.text()}`
      );
    }
    return response;
  }

  async #postJSON(operation: string, body: unknown): Promise<SFUResponse> {
    const response = await fetch(`${this.#endpoint}/${operation}`, {
      method: "POST",
      headers: this.#jsonHeaders,
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      throw new Error(
        `${operation} failed (${response.status}): ${await response.text()}`
      );
    }
    const result: unknown = await response.json();
    if (
      typeof result !== "object" ||
      result === null ||
      Array.isArray(result)
    ) {
      throw new Error(`${operation} response must be an object`);
    }
    return result as SFUResponse;
  }

  #requireSessionDescription(
    response: SFUResponse,
    operation: string
  ): RTCSessionDescriptionInit {
    const description = this.#sessionDescription(response);
    if (!description) {
      throw new Error(`${operation} response missing sessionDescription.sdp`);
    }
    return description;
  }

  #sessionDescription(response: SFUResponse): RTCSessionDescriptionInit | null {
    const value = response.sessionDescription;
    if (
      typeof value !== "object" ||
      value === null ||
      !("sdp" in value) ||
      typeof value.sdp !== "string"
    ) {
      return null;
    }
    const type =
      "type" in value && typeof value.type === "string" ? value.type : "answer";
    return { type: type as RTCSdpType, sdp: value.sdp };
  }

  async #createMicrophoneBridge(
    stream: MediaStream,
    generation: number
  ): Promise<MediaStream> {
    const context = new AudioContext();
    this.#analyserContext = context;
    await context.resume();
    this.#assertCurrent(generation);

    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    const destination = context.createMediaStreamDestination();
    analyser.fftSize = 2048;
    source.connect(analyser);
    source.connect(destination);
    const samples = new Float32Array(analyser.fftSize);

    const measure = () => {
      if (generation !== this.#generation) return;
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) sum += sample * sample;
      this.onAudioLevel?.(Math.sqrt(sum / samples.length));
      this.#animationFrame = requestAnimationFrame(measure);
    };
    this.#animationFrame = requestAnimationFrame(measure);
    return destination.stream;
  }

  #waitForConnected(
    peer: RTCPeerConnection,
    generation: number
  ): Promise<void> {
    if (peer.connectionState === "connected") return Promise.resolve();

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Microphone WebRTC connection timed out"));
      }, 15_000);
      const cleanup = () => {
        clearTimeout(timeout);
        peer.removeEventListener("connectionstatechange", onStateChange);
      };
      const onStateChange = () => {
        if (generation !== this.#generation) {
          cleanup();
          reject(new StaleStart());
        } else if (peer.connectionState === "connected") {
          cleanup();
          resolve();
        } else if (
          peer.connectionState === "failed" ||
          peer.connectionState === "closed"
        ) {
          cleanup();
          reject(new Error("Microphone WebRTC connection failed"));
        }
      };
      peer.addEventListener("connectionstatechange", onStateChange);
    });
  }

  #assertCurrent(generation: number): void {
    if (generation !== this.#generation) throw new StaleStart();
  }
}

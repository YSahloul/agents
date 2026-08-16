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
  /** Reports the RMS level of the remote TTS audio as it reaches playback. */
  onPlaybackAudioLevel?: (rms: number) => void;
  /**
   * RMS threshold below which the outbound microphone track sends silence.
   * Omit to disable the gate.
   */
  noiseGateThreshold?: number;
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
const NOISE_GATE_OPEN_FRAMES = 3;
const NOISE_GATE_CLOSE_DELAY_MS = 300;

export class SFUVoiceAudioInput implements VoiceAudioInput {
  readonly handlesPlayback = true;
  onAudioLevel: ((rms: number) => void) | null = null;
  onAudioData: ((pcm: ArrayBuffer) => void) | null = null;

  readonly #endpoint: string;
  readonly #iceServers: RTCIceServer[];
  readonly #headers: Headers;
  readonly #captureMicrophone: SFUVoiceAudioInputOptions["captureMicrophone"];
  readonly #onPlaybackAudioLevel:
    | SFUVoiceAudioInputOptions["onPlaybackAudioLevel"]
    | undefined;
  readonly #noiseGateThreshold: number | undefined;
  readonly #jsonHeaders: Headers;
  #generation = 0;
  #peer: RTCPeerConnection | null = null;
  #microphoneStream: MediaStream | null = null;
  #stopMicrophone: (() => void | Promise<void>) | null = null;
  #audioElement: HTMLAudioElement | null = null;
  #analyserContext: AudioContext | null = null;
  #animationFrame: number | null = null;
  #microphoneAnalyser: AnalyserNode | null = null;
  #microphoneSamples: Float32Array<ArrayBuffer> | null = null;
  #playbackAnalyser: AnalyserNode | null = null;
  #playbackSamples: Float32Array<ArrayBuffer> | null = null;
  #outboundMicrophoneTrack: MediaStreamTrack | null = null;
  #noiseGateOpen = false;
  #noiseGateLoudFrames = 0;
  #noiseGateCloseTimer: NodeJS.Timeout | null = null;
  #muted = false;
  #shouldStopForwarding = false;

  constructor(options: SFUVoiceAudioInputOptions) {
    this.#endpoint = options.endpoint.replace(/\/$/, "");
    this.#iceServers = options.iceServers ?? DEFAULT_ICE_SERVERS;
    this.#captureMicrophone = options.captureMicrophone;
    this.#onPlaybackAudioLevel = options.onPlaybackAudioLevel;
    this.#noiseGateThreshold = options.noiseGateThreshold;
    if (
      this.#noiseGateThreshold !== undefined &&
      (!Number.isFinite(this.#noiseGateThreshold) ||
        this.#noiseGateThreshold < 0 ||
        this.#noiseGateThreshold > 1)
    ) {
      throw new RangeError("noiseGateThreshold must be between 0 and 1");
    }
    this.#headers = new Headers(options.headers);
    this.#jsonHeaders = new Headers(this.#headers);
    this.#jsonHeaders.set("Content-Type", "application/json");
  }

  get microphoneSettings(): MediaTrackSettings | null {
    return this.#microphoneStream?.getAudioTracks()[0]?.getSettings() ?? null;
  }

  async start(): Promise<void> {
    const generation = ++this.#generation;
    this.#teardown(this.#shouldStopForwarding, false);
    this.#shouldStopForwarding = true;

    try {
      await this.#post("tts/publish");
      this.#assertCurrent(generation);

      const capture = this.#captureMicrophone
        ? await this.#captureMicrophone()
        : {
            stream: await navigator.mediaDevices.getUserMedia({
              audio: {
                sampleRate: 48000,
                channelCount: 1,
                echoCancellation: { exact: true },
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
      this.#microphoneStream = microphoneStream;
      this.#stopMicrophone = capture.stop ?? null;

      const microphoneTrack = microphoneStream.getAudioTracks()[0];
      if (!microphoneTrack) {
        throw new Error("Microphone stream has no audio track");
      }

      if (
        !this.#captureMicrophone &&
        microphoneTrack.getSettings().echoCancellation !== true
      ) {
        throw new Error("Browser did not enable required echo cancellation");
      }

      const outboundMicrophoneTrack =
        this.#noiseGateThreshold === undefined
          ? microphoneTrack
          : microphoneTrack.clone();
      this.#outboundMicrophoneTrack = outboundMicrophoneTrack;
      this.#noiseGateOpen = this.#noiseGateThreshold === undefined;
      this.#updateOutboundMicrophone();

      const peer = new RTCPeerConnection({ iceServers: this.#iceServers });
      this.#peer = peer;
      const microphoneTransceiver = peer.addTransceiver(
        outboundMicrophoneTrack,
        {
          direction: "sendonly",
          streams: [microphoneStream]
        }
      );

      const audio = document.createElement("audio");
      audio.autoplay = true;
      audio.style.display = "none";
      document.body.appendChild(audio);
      this.#audioElement = audio;
      peer.ontrack = (event) => {
        if (generation !== this.#generation || this.#peer !== peer) return;
        const playbackStream =
          event.streams[0] ?? new MediaStream([event.track]);
        audio.srcObject = playbackStream;
        this.#startPlaybackAudioLevelAnalysis(playbackStream);
        void audio.play().catch((error: unknown) => {
          console.warn("[SFUVoiceAudioInput] Audio playback failed:", error);
        });
      };

      await this.#startAudioLevelAnalysis(microphoneStream, generation);
      this.#assertCurrent(generation);

      const offer = await peer.createOffer();
      this.#assertCurrent(generation);
      await peer.setLocalDescription(offer);
      this.#assertCurrent(generation);
      const microphoneMid = microphoneTransceiver.mid;
      if (microphoneMid === null) {
        throw new Error(
          "Microphone transceiver missing mid after local description"
        );
      }

      const connectResponse = await this.#postJSON("rtc/connect", {
        sessionDescription: offer,
        microphoneMid
      });
      this.#assertCurrent(generation);
      const connectAnswer = this.#requireSessionDescription(
        connectResponse,
        "RTC connect"
      );
      await peer.setRemoteDescription(connectAnswer);
      this.#assertCurrent(generation);

      await this.#waitForConnected(peer, generation);
      this.#assertCurrent(generation);

      const pullResponse = await this.#postJSON("rtc/pull", {});
      this.#assertCurrent(generation);
      const pullOffer = this.#requirePullOffer(pullResponse);
      await peer.setRemoteDescription(pullOffer);
      this.#assertCurrent(generation);

      const answer = await peer.createAnswer();
      this.#assertCurrent(generation);
      await peer.setLocalDescription(answer);
      this.#assertCurrent(generation);
      await this.#postJSON("rtc/renegotiate", {
        sessionDescription: answer
      });
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
    if (this.#noiseGateCloseTimer !== null) {
      clearTimeout(this.#noiseGateCloseTimer);
      this.#noiseGateCloseTimer = null;
    }
    this.#microphoneAnalyser = null;
    this.#microphoneSamples = null;
    this.#playbackAnalyser = null;
    this.#playbackSamples = null;
    this.#onPlaybackAudioLevel?.(0);
    this.#peer?.close();
    this.#peer = null;
    const microphoneTrack = this.#microphoneStream?.getAudioTracks()[0] ?? null;
    if (
      this.#outboundMicrophoneTrack &&
      this.#outboundMicrophoneTrack !== microphoneTrack
    ) {
      this.#outboundMicrophoneTrack.stop();
    }
    this.#outboundMicrophoneTrack = null;
    this.#noiseGateOpen = false;
    this.#noiseGateLoudFrames = 0;
    this.#microphoneStream?.getTracks().forEach((track) => track.stop());
    this.#microphoneStream = null;
    const stopMicrophone = this.#stopMicrophone;
    this.#stopMicrophone = null;
    void Promise.resolve(stopMicrophone?.()).catch(() => {});
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
    this.#muted = muted;
    this.#microphoneStream
      ?.getAudioTracks()
      .forEach((track) => (track.enabled = !muted));
    this.#updateOutboundMicrophone();
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

  #requirePullOffer(response: SFUResponse): RTCSessionDescriptionInit {
    const description = this.#sessionDescription(response);
    if (
      response.requiresImmediateRenegotiation !== true ||
      description?.type !== "offer"
    ) {
      throw new Error(
        "RTC pull response missing required offer sessionDescription.sdp"
      );
    }
    return description;
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

  async #startAudioLevelAnalysis(
    stream: MediaStream,
    generation: number
  ): Promise<void> {
    const context = new AudioContext();
    this.#analyserContext = context;
    await context.resume();
    this.#assertCurrent(generation);

    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);
    this.#microphoneAnalyser = analyser;
    this.#microphoneSamples = new Float32Array(analyser.fftSize);

    const measure = () => {
      if (generation !== this.#generation) return;
      if (this.#microphoneAnalyser && this.#microphoneSamples) {
        const rms = this.#rms(
          this.#microphoneAnalyser,
          this.#microphoneSamples
        );
        this.#processNoiseGate(rms);
        this.onAudioLevel?.(rms);
      }
      if (this.#playbackAnalyser && this.#playbackSamples) {
        this.#onPlaybackAudioLevel?.(
          this.#rms(this.#playbackAnalyser, this.#playbackSamples)
        );
      }
      this.#animationFrame = requestAnimationFrame(measure);
    };
    this.#animationFrame = requestAnimationFrame(measure);
  }

  #startPlaybackAudioLevelAnalysis(stream: MediaStream): void {
    const context = this.#analyserContext;
    if (!context) return;
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);
    this.#playbackAnalyser = analyser;
    this.#playbackSamples = new Float32Array(analyser.fftSize);
  }

  #rms(analyser: AnalyserNode, samples: Float32Array<ArrayBuffer>): number {
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const sample of samples) sum += sample * sample;
    return Math.sqrt(sum / samples.length);
  }
  #processNoiseGate(rms: number): void {
    const threshold = this.#noiseGateThreshold;
    if (threshold === undefined) return;

    if (rms > threshold) {
      this.#noiseGateLoudFrames++;
      if (this.#noiseGateCloseTimer !== null) {
        clearTimeout(this.#noiseGateCloseTimer);
        this.#noiseGateCloseTimer = null;
      }
      if (this.#noiseGateLoudFrames >= NOISE_GATE_OPEN_FRAMES) {
        this.#noiseGateOpen = true;
        this.#updateOutboundMicrophone();
      }
      return;
    }

    this.#noiseGateLoudFrames = 0;
    if (!this.#noiseGateOpen || this.#noiseGateCloseTimer !== null) return;
    this.#noiseGateCloseTimer = globalThis.setTimeout(() => {
      this.#noiseGateCloseTimer = null;
      this.#noiseGateOpen = false;
      this.#updateOutboundMicrophone();
    }, NOISE_GATE_CLOSE_DELAY_MS);
  }

  #updateOutboundMicrophone(): void {
    if (!this.#outboundMicrophoneTrack) return;
    this.#outboundMicrophoneTrack.enabled = !this.#muted && this.#noiseGateOpen;
  }

  #waitForConnected(
    peer: RTCPeerConnection,
    generation: number
  ): Promise<void> {
    if (peer.connectionState === "connected") return Promise.resolve();

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("SFU WebRTC connection timed out"));
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
          reject(new Error("SFU WebRTC connection failed"));
        }
      };
      peer.addEventListener("connectionstatechange", onStateChange);
    });
  }

  #assertCurrent(generation: number): void {
    if (generation !== this.#generation) throw new StaleStart();
  }
}

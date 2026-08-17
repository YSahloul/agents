import type { VoiceServerAudioTransport } from "./types";
import {
  addSFUTracks,
  closeSFUWebSocketAdapter,
  createSFUSession,
  createSFUWebSocketAdapter,
  downsample48kStereoTo16kMono,
  encodePayloadToProtobuf,
  extractPayloadFromProtobuf,
  renegotiateSFUSession,
  resampleMonoTo48kStereo,
  type SFUConfig
} from "./sfu-utils";

declare const WebSocketPair: {
  new (): { 0: WebSocket; 1: WebSocket };
};

type WebSocketResponseInit = ResponseInit & { webSocket: WebSocket };

export interface SFUVoiceState {
  tts?: {
    sessionId: string;
    adapterId: string;
    trackName: string;
  };
  stt?: {
    sessionId: string;
    trackName: string;
    callbackUrl: string;
    adapterId?: string;
  };
}

export interface SFUVoiceTransportOptions {
  config: SFUConfig;
  routePrefix?: string;
  inputSampleRate?: number;
  loadState?: () => Promise<SFUVoiceState | null>;
  saveState?: (state: SFUVoiceState | null) => Promise<void>;
}

type SessionDescription = { type?: string; sdp: string };
type SFUResponse = {
  tracks?: unknown;
  sessionDescription?: unknown;
  requiresImmediateRenegotiation?: unknown;
  [key: string]: unknown;
};
type FlushMarker = {
  resolve: () => void;
  reject: (error: Error) => void;
};
type QueueItem = Uint8Array | FlushMarker;
type SocketWaiter = {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const FRAME_BYTES = 3840;
const FRAME_INTERVAL_MS = 20;
const GRACE_PERIOD_MS = 30_000;
const KEEPALIVE_INTERVAL_MS = 20_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class SFUVoiceTransport implements VoiceServerAudioTransport {
  readonly #config: SFUConfig;
  readonly #routePrefix: string;
  readonly #inputSampleRate: number;
  readonly #loadStateCallback:
    | (() => Promise<SFUVoiceState | null>)
    | undefined;
  readonly #saveStateCallback:
    | ((state: SFUVoiceState | null) => Promise<void>)
    | undefined;

  #state: SFUVoiceState | null = null;
  #stateLoaded = false;
  #stateLoad: Promise<SFUVoiceState | null> | null = null;
  #stateWrite: Promise<void> = Promise.resolve();

  #connectionId: string | null = null;
  #onAudio: ((audio: ArrayBuffer) => void) | null = null;
  #ttsSocket: WebSocket | null = null;
  #sttSockets = new Set<WebSocket>();
  #socketWaiters = new Set<SocketWaiter>();
  #sttFrameCount = 0;
  #sttPeak = 0;

  #queue: QueueItem[] = [];
  #partialFrame = new Uint8Array();
  #partialInputByte: number | null = null;
  #pacingTimer: ReturnType<typeof setInterval> | null = null;
  #suspendTimer: ReturnType<typeof setTimeout> | null = null;
  #keepaliveTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: SFUVoiceTransportOptions) {
    this.#config = options.config;
    this.#routePrefix =
      options.routePrefix?.replace(/^\/+|\/+$/g, "") || "voice";
    this.#inputSampleRate = options.inputSampleRate ?? 24000;
    if (this.#inputSampleRate <= 0) {
      throw new Error("SFU voice inputSampleRate must be greater than zero");
    }
    this.#loadStateCallback = options.loadState;
    this.#saveStateCallback = options.saveState;
  }

  async start(
    connectionId: string,
    onAudio: (audio: ArrayBuffer) => void
  ): Promise<void> {
    if (this.#connectionId && this.#connectionId !== connectionId) {
      throw new Error("SFU voice transport already has an active call");
    }
    this.#clearSuspendTimer();
    this.#connectionId = connectionId;
    this.#onAudio = onAudio;
    this.#sttFrameCount = 0;
    this.#sttPeak = 0;
    this.#partialInputByte = null;
    this.#startKeepalive();
    try {
      await this.#waitForTtsSocket(10_000);
    } catch (error) {
      if (this.#connectionId === connectionId) {
        this.#connectionId = null;
        this.#onAudio = null;
        this.#clearKeepalive();
      }
      throw error;
    }
  }

  send(connectionId: string, audio: ArrayBuffer): void {
    this.#requireActiveConnection(connectionId);
    this.#requireTtsSocket();

    const input = new Uint8Array(audio);
    let alignedAudio = audio;
    if (this.#partialInputByte !== null) {
      const combined = new Uint8Array(input.byteLength + 1);
      combined[0] = this.#partialInputByte;
      combined.set(input, 1);
      const alignedLength = combined.byteLength - (combined.byteLength % 2);
      this.#partialInputByte =
        alignedLength < combined.byteLength ? combined[alignedLength] : null;
      alignedAudio = combined.slice(0, alignedLength).buffer;
    } else if (input.byteLength % 2 !== 0) {
      this.#partialInputByte = input[input.byteLength - 1];
      alignedAudio = input.slice(0, -1).buffer;
    }

    const converted = resampleMonoTo48kStereo(
      alignedAudio,
      this.#inputSampleRate
    );
    if (converted.byteLength === 0) return;

    const combined = new Uint8Array(
      this.#partialFrame.byteLength + converted.byteLength
    );
    combined.set(this.#partialFrame);
    combined.set(converted, this.#partialFrame.byteLength);

    let offset = 0;
    while (combined.byteLength - offset >= FRAME_BYTES) {
      this.#queue.push(combined.slice(offset, offset + FRAME_BYTES));
      offset += FRAME_BYTES;
    }
    this.#partialFrame = combined.slice(offset);
    this.#startPacing();
  }

  flush(connectionId: string): Promise<void> {
    this.#requireActiveConnection(connectionId);
    this.#requireTtsSocket();
    this.#partialInputByte = null;
    if (this.#partialFrame.byteLength > 0) {
      const frame = new Uint8Array(FRAME_BYTES);
      frame.set(this.#partialFrame);
      this.#queue.push(frame);
      this.#partialFrame = new Uint8Array();
    }
    return new Promise((resolve, reject) => {
      this.#queue.push({ resolve, reject });
      console.log("[VoiceTrace]", {
        event: "sfu_flush_queued",
        connectionId,
        queuedAudioMs:
          this.#queue.filter((item) => item instanceof Uint8Array).length *
          FRAME_INTERVAL_MS
      });
      this.#startPacing();
    });
  }

  interrupt(connectionId: string): void {
    this.#requireActiveConnection(connectionId);
    const droppedAudioMs =
      this.#queue.filter((item) => item instanceof Uint8Array).length *
      FRAME_INTERVAL_MS;
    const socket = this.#requireTtsSocket();
    this.#clearPacing();
    this.#rejectQueue(new Error("SFU output interrupted"));
    this.#partialFrame = new Uint8Array();
    this.#partialInputByte = null;
    socket.send(encodePayloadToProtobuf(new Uint8Array()));
    console.log("[VoiceTrace]", {
      event: "sfu_interrupt",
      connectionId,
      droppedAudioMs
    });
  }

  async stop(connectionId: string): Promise<void> {
    this.#clearSuspendTimer();
    if (this.#connectionId !== connectionId) return;

    this.#connectionId = null;
    this.#onAudio = null;
    await this.#teardown();
  }

  suspend(connectionId: string): void {
    if (this.#connectionId !== connectionId) return;
    if (this.#suspendTimer) return;
    this.#connectionId = null;
    this.#onAudio = null;
    this.#clearKeepalive();
    this.#suspendTimer = setTimeout(() => {
      this.#suspendTimer = null;
      void this.#teardown();
    }, GRACE_PERIOD_MS);
  }

  async resume(
    connectionId: string,
    onAudio: (audio: ArrayBuffer) => void
  ): Promise<void> {
    this.#clearSuspendTimer();
    this.#connectionId = connectionId;
    this.#onAudio = onAudio;
    this.#startKeepalive();
    try {
      const state = await this.#loadState();
      if (!state?.tts) {
        // Grace window already expired (or nothing was ever suspended) --
        // fail fast instead of waiting out the full TTS callback timeout
        // for a socket that will never arrive on its own.
        throw new Error(
          "SFU voice transport has no suspended session to resume"
        );
      }
      if (state.stt && !state.stt.adapterId) {
        await this.#startSttForwarding();
      }
      await this.#waitForTtsSocket(10_000);
    } catch (error) {
      if (this.#connectionId === connectionId) {
        this.#connectionId = null;
        this.#onAudio = null;
        this.#clearKeepalive();
      }
      throw error;
    }
  }

  async #teardown(): Promise<void> {
    this.#clearPacing();
    this.#clearKeepalive();
    this.#rejectQueue(new Error("SFU voice transport stopped"));
    this.#partialFrame = new Uint8Array();
    this.#partialInputByte = null;
    this.#rejectSocketWaiters(new Error("SFU voice transport stopped"));

    const adapterIds: string[] = [];
    await this.#updateState((state) => {
      for (const adapterId of [state?.tts?.adapterId, state?.stt?.adapterId]) {
        if (adapterId) adapterIds.push(adapterId);
      }
      return null;
    });
    await Promise.all(
      adapterIds.map((adapterId) => this.#closeAdapter(adapterId))
    );

    if (this.#ttsSocket) {
      this.#ttsSocket.close(1000, "Voice stopped");
      this.#ttsSocket = null;
    }
    for (const socket of this.#sttSockets) {
      socket.close(1000, "Voice stopped");
    }
    this.#sttSockets.clear();
  }

  #startKeepalive(): void {
    if (this.#keepaliveTimer) return;
    this.#keepaliveTimer = setInterval(() => {
      const socket = this.#ttsSocket;
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      if (this.#queue.length === 0) {
        socket.send(encodePayloadToProtobuf(new Uint8Array(FRAME_BYTES)));
      }
    }, KEEPALIVE_INTERVAL_MS);
  }

  #clearKeepalive(): void {
    if (!this.#keepaliveTimer) return;
    clearInterval(this.#keepaliveTimer);
    this.#keepaliveTimer = null;
  }

  #clearSuspendTimer(): void {
    if (!this.#suspendTimer) return;
    clearTimeout(this.#suspendTimer);
    this.#suspendTimer = null;
  }

  handleWebSocketUpgrade(request: Request): Response | null {
    if (
      request.method !== "GET" ||
      request.headers.get("Upgrade")?.toLowerCase() !== "websocket"
    ) {
      return null;
    }

    const path = new URL(request.url).pathname;
    if (path.endsWith(this.#route("tts/subscribe"))) {
      return this.#handleTtsSubscribe();
    }
    if (path.endsWith(this.#route("stt/sfu-subscribe"))) {
      return this.#handleSttSubscribe();
    }
    return null;
  }

  async handleHttpRequest(request: Request): Promise<Response | null> {
    if (request.method !== "POST") return null;
    const path = new URL(request.url).pathname;

    if (path.endsWith(this.#route("tts/publish"))) {
      return this.#respond("TTS publish", () => this.#publishTts(request));
    }
    if (path.endsWith(this.#route("rtc/connect"))) {
      return this.#respond("RTC connect", () => this.#connectRtc(request));
    }
    if (path.endsWith(this.#route("rtc/pull"))) {
      return this.#respond("RTC pull", () => this.#pullTts());
    }
    if (path.endsWith(this.#route("rtc/renegotiate"))) {
      return this.#respond("RTC renegotiate", () =>
        this.#renegotiateRtc(request)
      );
    }
    if (path.endsWith(this.#route("stt/start-forwarding"))) {
      return this.#respond("STT start forwarding", () =>
        this.#startSttForwarding()
      );
    }
    if (path.endsWith(this.#route("stt/stop-forwarding"))) {
      return this.#respond("STT stop forwarding", () =>
        this.#stopSttForwarding()
      );
    }
    return null;
  }

  async #respond(
    operation: string,
    handler: () => Promise<Response>
  ): Promise<Response> {
    try {
      return await handler();
    } catch (error) {
      console.error(`[SFUVoiceTransport] ${operation} failed:`, error);
      return new Response(`${operation} failed: ${errorMessage(error)}`, {
        status: 500
      });
    }
  }

  async #publishTts(request: Request): Promise<Response> {
    let previousAdapterId: string | undefined;
    await this.#updateState((state) => {
      previousAdapterId = state?.tts?.adapterId;
      return state?.stt ? { stt: state.stt } : null;
    });
    if (previousAdapterId) {
      await this.#closeAdapter(previousAdapterId);
    }

    const callbackUrl = this.#callbackUrl(
      request,
      "tts/publish",
      "tts/subscribe"
    );

    // Retry adapter creation + callback wait up to 3 times.
    // The SFU's WebSocket callback is intermittently unreliable — the first
    // attempt often fails (adapter created but WS callback never arrives),
    // but a fresh adapter on retry succeeds.
    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const trackName = `tts-${crypto.randomUUID()}`;
      const result = await createSFUWebSocketAdapter(this.#config, [
        {
          location: "local",
          trackName,
          endpoint: callbackUrl,
          inputCodec: "pcm",
          mode: "buffer"
        }
      ]);
      const response = this.#asResponse(result, "create WebSocket adapter");
      const firstTrack = this.#firstTrack(response, "create WebSocket adapter");
      if (
        typeof firstTrack.sessionId !== "string" ||
        typeof firstTrack.adapterId !== "string"
      ) {
        throw new Error(
          "SFU create WebSocket adapter response missing tracks[0].sessionId or tracks[0].adapterId"
        );
      }

      await this.#updateState((current) => ({
        ...(current ?? {}),
        tts: {
          sessionId: firstTrack.sessionId as string,
          adapterId: firstTrack.adapterId as string,
          trackName
        }
      }));

      try {
        await this.#waitForTtsSocket(5_000);
        // Realtime cannot pull a WebSocket-ingest track until it has received
        // media. Prime it with one silent 20 ms frame before the browser pulls.
        this.#requireTtsSocket().send(
          encodePayloadToProtobuf(new Uint8Array(FRAME_BYTES))
        );
        return Response.json({
          ...response,
          sessionId: firstTrack.sessionId,
          adapterId: firstTrack.adapterId,
          trackName
        });
      } catch {
        if (attempt < MAX_ATTEMPTS) {
          console.warn(
            `[SFUVoiceTransport] TTS callback timeout, retrying (attempt ${attempt}/${MAX_ATTEMPTS})`
          );
          // Clear stale socket and adapter before retrying
          if (this.#ttsSocket) {
            this.#ttsSocket.close(1000, "Retry");
            this.#ttsSocket = null;
          }
          await this.#closeAdapter(firstTrack.adapterId as string);
        }
      }
    }
    throw new Error("SFU TTS callback timeout after all retry attempts");
  }

  async #connectRtc(request: Request): Promise<Response> {
    const connect = await this.#readRtcConnect(request);
    if (!connect) {
      return new Response("Missing sessionDescription.sdp or microphoneMid", {
        status: 400
      });
    }

    const { sessionId } = await createSFUSession(this.#config);
    const microphoneTrackName = `stt-${crypto.randomUUID()}`;
    const result = await addSFUTracks(this.#config, sessionId, {
      sessionDescription: connect.sessionDescription,
      tracks: [
        {
          location: "local",
          mid: connect.microphoneMid,
          trackName: microphoneTrackName,
          kind: "audio"
        }
      ]
    });
    const response = this.#asResponse(result, "connect RTC session");
    if (!this.#normalizeSessionDescription(response)) {
      throw new Error(
        "SFU connect RTC session response missing sessionDescription.sdp"
      );
    }

    const callbackUrl = this.#callbackUrl(
      request,
      "rtc/connect",
      "stt/sfu-subscribe"
    );
    await this.#updateState((current) => ({
      ...(current ?? {}),
      stt: {
        sessionId,
        trackName: microphoneTrackName,
        callbackUrl
      }
    }));
    return Response.json(response);
  }

  async #pullTts(): Promise<Response> {
    const state = await this.#loadState();
    if (!state?.tts) {
      return new Response("TTS not published yet", { status: 400 });
    }
    if (!state.stt) {
      return new Response("RTC session not connected yet", { status: 400 });
    }

    for (let attempt = 0; ; attempt++) {
      const result = await addSFUTracks(this.#config, state.stt.sessionId, {
        tracks: [
          {
            location: "remote",
            sessionId: state.tts.sessionId,
            trackName: state.tts.trackName,
            kind: "audio"
          }
        ]
      });
      const response = this.#asResponse(result, "pull TTS track");
      const firstTrack = this.#firstTrack(response, "pull TTS track");
      if (!("errorCode" in firstTrack)) return Response.json(response);
      if (firstTrack.errorCode === "empty_track_error" && attempt < 4) {
        await new Promise((resolve) =>
          setTimeout(resolve, FRAME_INTERVAL_MS * (attempt + 1))
        );
        continue;
      }
      throw new Error(
        `SFU pull TTS track failed: ${String(firstTrack.errorCode)}`
      );
    }
  }

  async #renegotiateRtc(request: Request): Promise<Response> {
    const state = await this.#loadState();
    if (!state?.stt?.sessionId) {
      return new Response(
        "No RTC session to renegotiate. Call connect first.",
        { status: 400 }
      );
    }
    const description = await this.#readSessionDescription(request);
    if (!description) {
      return new Response("Missing sessionDescription.sdp", { status: 400 });
    }
    const result = await renegotiateSFUSession(
      this.#config,
      state.stt.sessionId,
      description
    );
    return Response.json(result);
  }

  async #startSttForwarding(): Promise<Response> {
    const state = await this.#loadState();
    if (!state?.stt) {
      return new Response("STT not connected yet", { status: 400 });
    }
    if (state.stt.adapterId) {
      return new Response("Forwarding already active");
    }

    const result = await createSFUWebSocketAdapter(this.#config, [
      {
        location: "remote",
        sessionId: state.stt.sessionId,
        trackName: state.stt.trackName,
        endpoint: state.stt.callbackUrl,
        outputCodec: "pcm"
      }
    ]);
    const response = this.#asResponse(result, "start STT forwarding");
    const firstTrack = this.#firstTrack(response, "start STT forwarding");
    if (typeof firstTrack.adapterId !== "string") {
      throw new Error(
        "SFU start STT forwarding response missing tracks[0].adapterId"
      );
    }
    await this.#updateState((current) => {
      if (!current?.stt) return current;
      return {
        ...current,
        stt: { ...current.stt, adapterId: firstTrack.adapterId as string }
      };
    });
    return new Response("Forwarding started");
  }

  async #stopSttForwarding(): Promise<Response> {
    let adapterId: string | undefined;
    await this.#updateState((state) => {
      adapterId = state?.stt?.adapterId;
      if (!state?.stt || !adapterId) return state;
      const stt = { ...state.stt };
      delete stt.adapterId;
      return { ...state, stt };
    });
    if (!adapterId) {
      return new Response("Forwarding not active");
    }
    await this.#closeAdapter(adapterId);
    return new Response("Forwarding stopped");
  }

  #handleTtsSubscribe(): Response {
    console.log("[VoiceTrace]", {
      event: "tts_subscribe_received",
      connectionId: this.#connectionId,
      hasExistingSocket: !!this.#ttsSocket
    });
    const { 0: client, 1: server } = new WebSocketPair();
    server.accept();
    server.binaryType = "arraybuffer";
    if (this.#ttsSocket && this.#ttsSocket !== server) {
      console.log("[VoiceTrace]", {
        event: "tts_subscribe_replacing",
        connectionId: this.#connectionId
      });
      this.#ttsSocket.close(1000, "Replaced");
    }
    this.#ttsSocket = server;
    this.#resolveSocketWaiters();
    server.addEventListener("close", () => {
      console.log("[VoiceTrace]", {
        event: "tts_socket_closed",
        connectionId: this.#connectionId
      });
      this.#clearTtsSocket(server);
    });
    server.addEventListener("error", (event: Event) => {
      console.error("[SFUVoiceTransport] TTS callback socket error:", event);
      this.#clearTtsSocket(server);
    });
    console.log("[VoiceTrace]", {
      event: "tts_subscribe_responded",
      connectionId: this.#connectionId
    });
    return new Response(null, {
      status: 101,
      webSocket: client
    } as WebSocketResponseInit);
  }

  #handleSttSubscribe(): Response {
    const { 0: client, 1: server } = new WebSocketPair();
    server.accept();
    server.binaryType = "arraybuffer";
    this.#sttSockets.add(server);
    server.addEventListener("message", (event: MessageEvent) => {
      if (!(event.data instanceof ArrayBuffer)) return;
      const payload = extractPayloadFromProtobuf(event.data);
      if (!payload || payload.byteLength === 0) return;
      const samples = new Int16Array(payload.buffer);
      let peak = 0;
      for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
      this.#sttFrameCount++;
      this.#sttPeak = Math.max(this.#sttPeak, peak);
      if (this.#sttFrameCount === 1 || this.#sttFrameCount % 250 === 0) {
        console.log("[VoiceTrace]", {
          event: "sfu_stt_audio",
          connectionId: this.#connectionId,
          frames: this.#sttFrameCount,
          bytes: payload.byteLength,
          peak: this.#sttPeak
        });
      }
      const callback = this.#onAudio;
      if (!callback) return;
      callback(downsample48kStereoTo16kMono(payload));
    });
    server.addEventListener("close", () => this.#sttSockets.delete(server));
    server.addEventListener("error", (event: Event) => {
      console.error("[SFUVoiceTransport] STT callback socket error:", event);
      this.#sttSockets.delete(server);
    });
    return new Response(null, {
      status: 101,
      webSocket: client
    } as WebSocketResponseInit);
  }

  #startPacing(): void {
    if (this.#pacingTimer || this.#queue.length === 0) return;
    this.#pacingTimer = setInterval(() => {
      const socket = this.#ttsSocket;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        this.#clearTtsSocket(socket);
        return;
      }
      const item = this.#queue.shift();
      if (item === undefined) {
        this.#clearPacing();
        return;
      }
      if (item instanceof Uint8Array) {
        socket.send(encodePayloadToProtobuf(item));
      } else {
        socket.send(encodePayloadToProtobuf(new Uint8Array()));
        item.resolve();
        console.log("[VoiceTrace]", {
          event: "sfu_flush_sent",
          connectionId: this.#connectionId,
          remainingAudioMs:
            this.#queue.filter((queued) => queued instanceof Uint8Array)
              .length * FRAME_INTERVAL_MS
        });
      }
      if (this.#queue.length === 0) this.#clearPacing();
    }, FRAME_INTERVAL_MS);
  }

  #clearPacing(): void {
    if (!this.#pacingTimer) return;
    clearInterval(this.#pacingTimer);
    this.#pacingTimer = null;
  }

  #rejectQueue(error: Error): void {
    const queue = this.#queue.splice(0);
    for (const item of queue) {
      if (!(item instanceof Uint8Array)) item.reject(error);
    }
  }

  #clearTtsSocket(socket: WebSocket | null): void {
    if (!socket || this.#ttsSocket !== socket) return;
    this.#ttsSocket = null;
    this.#clearPacing();
    this.#rejectQueue(new Error("SFU TTS socket closed"));
    this.#partialFrame = new Uint8Array();
    this.#partialInputByte = null;
  }

  #requireActiveConnection(connectionId: string): void {
    if (this.#connectionId !== connectionId) {
      throw new Error("SFU voice transport connection is not active");
    }
  }

  #requireTtsSocket(): WebSocket {
    if (!this.#ttsSocket || this.#ttsSocket.readyState !== WebSocket.OPEN) {
      throw new Error("SFU TTS socket is not connected");
    }
    return this.#ttsSocket;
  }

  #waitForTtsSocket(timeoutMs: number): Promise<void> {
    if (this.#ttsSocket?.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const waiter: SocketWaiter = {
        resolve: () => {
          clearTimeout(waiter.timer);
          this.#socketWaiters.delete(waiter);
          resolve();
        },
        reject: (error: Error) => {
          clearTimeout(waiter.timer);
          this.#socketWaiters.delete(waiter);
          reject(error);
        },
        timer: setTimeout(() => {
          this.#socketWaiters.delete(waiter);
          reject(
            new Error(`SFU TTS callback timeout after ${timeoutMs / 1000}s`)
          );
        }, timeoutMs)
      };
      this.#socketWaiters.add(waiter);
    });
  }

  #resolveSocketWaiters(): void {
    for (const waiter of [...this.#socketWaiters]) waiter.resolve();
  }

  #rejectSocketWaiters(error: Error): void {
    for (const waiter of [...this.#socketWaiters]) waiter.reject(error);
  }

  async #loadState(): Promise<SFUVoiceState | null> {
    if (this.#stateLoaded) return this.#state;
    if (this.#stateLoad) return this.#stateLoad;
    this.#stateLoad = (async () => {
      const state = (await this.#loadStateCallback?.()) ?? null;
      this.#state = state;
      this.#stateLoaded = true;
      return state;
    })();
    try {
      return await this.#stateLoad;
    } finally {
      this.#stateLoad = null;
    }
  }

  async #replaceState(state: SFUVoiceState | null): Promise<void> {
    await this.#saveStateCallback?.(state);
    this.#state = state;
    this.#stateLoaded = true;
  }

  #updateState(
    update: (state: SFUVoiceState | null) => SFUVoiceState | null
  ): Promise<void> {
    const write = this.#stateWrite.then(async () => {
      const current = await this.#loadState();
      await this.#replaceState(update(current));
    });
    this.#stateWrite = write.catch(() => {});
    return write;
  }

  async #readRtcConnect(request: Request): Promise<{
    sessionDescription: SessionDescription;
    microphoneMid: string;
  } | null> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return null;
    }
    if (
      typeof body !== "object" ||
      body === null ||
      !("sessionDescription" in body) ||
      typeof body.sessionDescription !== "object" ||
      body.sessionDescription === null ||
      !("sdp" in body.sessionDescription) ||
      typeof body.sessionDescription.sdp !== "string" ||
      body.sessionDescription.sdp.length === 0 ||
      !("microphoneMid" in body) ||
      typeof body.microphoneMid !== "string" ||
      body.microphoneMid.length === 0
    ) {
      return null;
    }
    const type =
      "type" in body.sessionDescription &&
      typeof body.sessionDescription.type === "string"
        ? body.sessionDescription.type
        : undefined;
    return {
      sessionDescription: { type, sdp: body.sessionDescription.sdp },
      microphoneMid: body.microphoneMid
    };
  }

  async #readSessionDescription(
    request: Request
  ): Promise<SessionDescription | null> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return null;
    }
    if (
      typeof body !== "object" ||
      body === null ||
      !("sessionDescription" in body) ||
      typeof body.sessionDescription !== "object" ||
      body.sessionDescription === null ||
      !("sdp" in body.sessionDescription) ||
      typeof body.sessionDescription.sdp !== "string"
    ) {
      return null;
    }
    const type =
      "type" in body.sessionDescription &&
      typeof body.sessionDescription.type === "string"
        ? body.sessionDescription.type
        : undefined;
    return { type, sdp: body.sessionDescription.sdp };
  }

  #asResponse(value: unknown, operation: string): SFUResponse {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`SFU ${operation} response must be an object`);
    }
    return value as SFUResponse;
  }

  #firstTrack(response: SFUResponse, operation: string): SFUResponse {
    if (
      !Array.isArray(response.tracks) ||
      typeof response.tracks[0] !== "object" ||
      response.tracks[0] === null ||
      Array.isArray(response.tracks[0])
    ) {
      throw new Error(`SFU ${operation} response missing tracks[0]`);
    }
    return response.tracks[0] as SFUResponse;
  }

  #normalizeSessionDescription(response: SFUResponse): boolean {
    if (
      typeof response.sessionDescription !== "object" ||
      response.sessionDescription === null ||
      !("sdp" in response.sessionDescription) ||
      typeof response.sessionDescription.sdp !== "string"
    ) {
      return false;
    }
    const description = response.sessionDescription as {
      sdp: string;
      type?: unknown;
    };
    if (typeof description.type !== "string") {
      description.type = "answer";
    }
    return true;
  }

  async #closeAdapter(adapterId: string): Promise<void> {
    try {
      await closeSFUWebSocketAdapter(this.#config, adapterId);
    } catch (error) {
      console.warn("[SFUVoiceTransport] Adapter cleanup failed:", error);
    }
  }

  #route(operation: string): string {
    return `/${this.#routePrefix}/${operation}`;
  }

  #callbackUrl(request: Request, from: string, to: string): string {
    const url = new URL(request.url);
    const fromSuffix = this.#route(from);
    url.pathname = `${url.pathname.slice(0, -fromSuffix.length)}${this.#route(to)}`;
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString();
  }
}

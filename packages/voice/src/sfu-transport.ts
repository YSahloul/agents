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
    playerSessionId?: string;
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
  #pacingTimer: ReturnType<typeof setInterval> | null = null;

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
    this.#connectionId = connectionId;
    this.#onAudio = onAudio;
    this.#sttFrameCount = 0;
    this.#sttPeak = 0;
    try {
      await this.#waitForTtsSocket(10_000);
    } catch (error) {
      if (this.#connectionId === connectionId) {
        this.#connectionId = null;
        this.#onAudio = null;
      }
      throw error;
    }
  }

  send(connectionId: string, audio: ArrayBuffer): void {
    this.#requireActiveConnection(connectionId);
    this.#requireTtsSocket();

    const converted = resampleMonoTo48kStereo(audio, this.#inputSampleRate);
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
    socket.send(encodePayloadToProtobuf(new Uint8Array()));
    console.log("[VoiceTrace]", {
      event: "sfu_interrupt",
      connectionId,
      droppedAudioMs
    });
  }

  async stop(connectionId: string): Promise<void> {
    if (this.#connectionId !== connectionId) return;

    this.#connectionId = null;
    this.#onAudio = null;
    this.#clearPacing();
    this.#rejectQueue(new Error("SFU voice transport stopped"));
    this.#partialFrame = new Uint8Array();
    this.#rejectSocketWaiters(new Error("SFU voice transport stopped"));

    if (this.#ttsSocket) {
      this.#ttsSocket.close(1000, "Voice stopped");
      this.#ttsSocket = null;
    }
    for (const socket of this.#sttSockets) {
      socket.close(1000, "Voice stopped");
    }
    this.#sttSockets.clear();

    await this.#stateWrite;
    const state = await this.#loadState();
    const adapterIds = [state?.tts?.adapterId, state?.stt?.adapterId].filter(
      (adapterId): adapterId is string => typeof adapterId === "string"
    );
    await Promise.all(
      adapterIds.map((adapterId) => this.#closeAdapter(adapterId))
    );
    await this.#replaceState(null);
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
    if (path.endsWith(this.#route("tts/connect"))) {
      return this.#respond("TTS connect", () => this.#connectTts(request));
    }
    if (path.endsWith(this.#route("tts/renegotiate"))) {
      return this.#respond("TTS renegotiate", () =>
        this.#renegotiateTts(request)
      );
    }
    if (path.endsWith(this.#route("stt/connect"))) {
      return this.#respond("STT connect", () => this.#connectStt(request));
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
    const state = await this.#loadState();
    if (state?.tts?.adapterId) {
      await this.#updateState((current) =>
        current?.stt ? { stt: current.stt } : null
      );
      await this.#closeAdapter(state.tts.adapterId);
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

  async #connectTts(request: Request): Promise<Response> {
    const state = await this.#loadState();
    if (!state?.tts) {
      return new Response("TTS not published yet", { status: 400 });
    }
    const description = await this.#readSessionDescription(request);
    if (!description) {
      return new Response("Missing sessionDescription.sdp", { status: 400 });
    }

    const { sessionId: playerSessionId } = await createSFUSession(this.#config);
    const result = await addSFUTracks(this.#config, playerSessionId, {
      sessionDescription: description,
      tracks: [
        {
          location: "remote",
          sessionId: state.tts.sessionId,
          trackName: state.tts.trackName,
          kind: "audio"
        }
      ]
    });
    const response = this.#asResponse(result, "connect TTS track");
    const hasDescription = this.#normalizeSessionDescription(response);
    if (!hasDescription && response.requiresImmediateRenegotiation !== true) {
      throw new Error(
        "SFU connect TTS track response missing sessionDescription.sdp or requiresImmediateRenegotiation"
      );
    }

    await this.#updateState((current) => {
      if (!current?.tts) return current;
      return {
        ...current,
        tts: { ...current.tts, playerSessionId }
      };
    });
    return Response.json(response);
  }

  async #renegotiateTts(request: Request): Promise<Response> {
    const state = await this.#loadState();
    if (!state?.tts?.playerSessionId) {
      return new Response(
        "No player session to renegotiate. Call connect first.",
        { status: 400 }
      );
    }
    const description = await this.#readSessionDescription(request);
    if (!description) {
      return new Response("Missing sessionDescription.sdp", { status: 400 });
    }
    const result = await renegotiateSFUSession(
      this.#config,
      state.tts.playerSessionId,
      description.sdp
    );
    return Response.json(result);
  }

  async #connectStt(request: Request): Promise<Response> {
    const description = await this.#readSessionDescription(request);
    if (!description) {
      return new Response("Missing sessionDescription.sdp", { status: 400 });
    }

    const { sessionId } = await createSFUSession(this.#config);
    const result = await addSFUTracks(this.#config, sessionId, {
      autoDiscover: true,
      sessionDescription: description
    });
    const response = this.#asResponse(result, "connect STT track");
    if (!this.#normalizeSessionDescription(response)) {
      throw new Error(
        "SFU connect STT track response missing sessionDescription.sdp"
      );
    }
    const tracks = Array.isArray(response.tracks) ? response.tracks : [];
    const audioTrack = tracks.find(
      (track) =>
        typeof track === "object" &&
        track !== null &&
        "trackName" in track &&
        (track.kind === "audio" || !("kind" in track))
    );
    if (
      typeof audioTrack !== "object" ||
      audioTrack === null ||
      !("trackName" in audioTrack) ||
      typeof audioTrack.trackName !== "string"
    ) {
      throw new Error("SFU connect STT track response missing audio trackName");
    }

    const callbackUrl = this.#callbackUrl(
      request,
      "stt/connect",
      "stt/sfu-subscribe"
    );
    await this.#updateState((current) => ({
      ...(current ?? {}),
      stt: {
        sessionId,
        trackName: audioTrack.trackName as string,
        callbackUrl
      }
    }));
    return Response.json(response);
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
    const state = await this.#loadState();
    if (!state?.stt?.adapterId) {
      return new Response("Forwarding not active");
    }
    const adapterId = state.stt.adapterId;
    await this.#updateState((current) => {
      if (!current?.stt) return current;
      const stt = { ...current.stt };
      delete stt.adapterId;
      return { ...current, stt };
    });
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

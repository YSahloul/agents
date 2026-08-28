/**
 * Server-side VoiceAgent tests with continuous transcriber.
 *
 * Tests cover: voice protocol, continuous STT pipeline flow,
 * multi-turn conversation, interruption handling (session survives),
 * text messages, transient conversation history, and beforeCallStart.
 */
import { env } from "cloudflare:workers";
import { createExecutionContext, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import worker from "./worker";
import type { TestVoiceAgent } from "./agents/voice";

// --- Helpers ---
async function connectWS(path: string) {
  const ctx = createExecutionContext();
  const req = new Request(`http://example.com${path}`, {
    headers: { Upgrade: "websocket" }
  });
  const res = await worker.fetch(req, env, ctx);
  expect(res.status).toBe(101);
  const ws = res.webSocket as WebSocket;
  expect(ws).toBeDefined();
  ws.accept();
  return { ws, ctx };
}

function waitForMessageMatching(
  ws: WebSocket,
  predicate: (msg: unknown) => boolean,
  timeout = 5000
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timeout waiting for matching message")),
      timeout
    );
    const handler = (e: MessageEvent) => {
      const msg = typeof e.data === "string" ? JSON.parse(e.data) : e.data;
      if (predicate(msg)) {
        clearTimeout(timer);
        ws.removeEventListener("message", handler);
        resolve(msg);
      }
    };
    ws.addEventListener("message", handler);
  });
}

function sendJSON(ws: WebSocket, msg: Record<string, unknown>) {
  ws.send(JSON.stringify(msg));
}

let instanceCounter = 0;
function uniquePath() {
  return `/agents/test-voice-agent/voice-test-${++instanceCounter}`;
}

function uniqueContextPath() {
  return `/agents/test-context-voice-agent/voice-test-${++instanceCounter}`;
}

function uniqueAISDKStreamPath() {
  return `/agents/test-ai-sdk-full-stream-voice-agent/voice-test-${++instanceCounter}`;
}

function uniqueAISDKTextStreamPath() {
  return `/agents/test-ai-sdk-text-stream-voice-agent/voice-test-${++instanceCounter}`;
}

function uniqueStreamingTTSPath() {
  return `/agents/test-streaming-tts-voice-agent/voice-test-${++instanceCounter}`;
}

function uniqueMinInterruptPath() {
  return `/agents/test-min-interrupt-voice-agent/voice-test-${++instanceCounter}`;
}

function waitForStatus(ws: WebSocket, status: string) {
  return waitForMessageMatching(
    ws,
    (m) =>
      typeof m === "object" &&
      m !== null &&
      (m as Record<string, unknown>).type === "status" &&
      (m as Record<string, unknown>).status === status
  );
}

function waitForType(ws: WebSocket, type: string) {
  return waitForMessageMatching(
    ws,
    (m) =>
      typeof m === "object" &&
      m !== null &&
      (m as Record<string, unknown>).type === type
  );
}

async function waitForAck(ws: WebSocket, command: string): Promise<void> {
  await waitForMessageMatching(
    ws,
    (m) =>
      typeof m === "object" &&
      m !== null &&
      (m as Record<string, unknown>).type === "_ack" &&
      (m as Record<string, unknown>).command === command
  );
}

async function getTransportEvents(ws: WebSocket): Promise<string[]> {
  const response = waitForType(ws, "_transport_events");
  sendJSON(ws, { type: "_get_transport_events" });
  const message = (await response) as { events: string[] };
  return message.events;
}

async function setTranscriberMode(
  ws: WebSocket,
  value:
    | "default"
    | "missing"
    | "pending_ready"
    | "pending_ready_no_close_settle"
    | "reject_ready"
    | "create_throw"
): Promise<void> {
  sendJSON(ws, { type: "_set_transcriber_mode", value });
  await waitForAck(ws, "_set_transcriber_mode");
}

async function setBeforeCallStart(
  ws: WebSocket,
  value: boolean | "throw"
): Promise<void> {
  sendJSON(ws, { type: "_set_before_call_start", value });
  await waitForAck(ws, "_set_before_call_start");
}

async function setKeepAliveThrow(ws: WebSocket, value: boolean): Promise<void> {
  sendJSON(ws, { type: "_set_keep_alive_throw", value });
  await waitForAck(ws, "_set_keep_alive_throw");
}

async function waitForMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
type TurnState = { transcripts: string[]; abortCount: number };

async function getTurnState(ws: WebSocket): Promise<TurnState> {
  const response = waitForType(ws, "_turn_state");
  sendJSON(ws, { type: "_get_turn_state" });
  const message = await response;
  if (
    typeof message !== "object" ||
    message === null ||
    !("transcripts" in message) ||
    !Array.isArray(message.transcripts) ||
    !message.transcripts.every((value) => typeof value === "string") ||
    !("abortCount" in message) ||
    typeof message.abortCount !== "number"
  ) {
    throw new Error("Invalid _turn_state response");
  }
  return {
    transcripts: message.transcripts,
    abortCount: message.abortCount
  };
}

async function getMessageCount(ws: WebSocket): Promise<number> {
  const response = waitForType(ws, "_message_count");
  sendJSON(ws, { type: "_get_message_count" });
  const message = await response;
  if (
    typeof message !== "object" ||
    message === null ||
    !("count" in message) ||
    typeof message.count !== "number"
  ) {
    throw new Error("Invalid _message_count response");
  }
  return message.count;
}

async function getCounts(
  ws: WebSocket
): Promise<{ interrupt: number; [key: string]: unknown }> {
  const response = waitForType(ws, "_counts");
  sendJSON(ws, { type: "_get_counts" });
  const message = await response;
  if (
    typeof message !== "object" ||
    message === null ||
    !("interrupt" in message) ||
    typeof message.interrupt !== "number"
  ) {
    throw new Error("Invalid _counts response");
  }
  return { ...message, interrupt: message.interrupt };
}

async function setTurnMode(
  ws: WebSocket,
  value: "normal" | "reject" | "until_abort"
): Promise<void> {
  sendJSON(ws, { type: "_set_turn_mode", value });
  await waitForAck(ws, "_set_turn_mode");
}

async function setTtsMode(
  ws: WebSocket,
  value: "normal" | "controlled" | "marked" | "sentence"
): Promise<void> {
  sendJSON(ws, { type: "_set_tts_mode", value });
  await waitForAck(ws, "_set_tts_mode");
}

async function startCall(ws: WebSocket): Promise<void> {
  sendJSON(ws, { type: "start_call" });
  await waitForStatus(ws, "listening");
}

function recordSocket(ws: WebSocket) {
  const messages: Record<string, unknown>[] = [];
  const events: Array<Record<string, unknown> | "binary"> = [];
  let binaryCount = 0;
  const handler = (event: MessageEvent) => {
    if (typeof event.data === "string") {
      const message = JSON.parse(event.data) as Record<string, unknown>;
      messages.push(message);
      events.push(message);
    } else {
      binaryCount++;
      events.push("binary");
    }
  };
  ws.addEventListener("message", handler);
  return {
    messages,
    events,
    get binaryCount() {
      return binaryCount;
    },
    stop() {
      ws.removeEventListener("message", handler);
    }
  };
}

async function waitForTransportEventCount(
  ws: WebSocket,
  event: string,
  expectedCount: number
): Promise<string[]> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const events = await getTransportEvents(ws);
    if (events.filter((value) => value === event).length >= expectedCount) {
      return events;
    }
    await waitForMicrotasks();
  }
  throw new Error(
    `Timed out waiting for ${expectedCount} "${event}" transport events`
  );
}
async function waitUntilTurnState(
  ws: WebSocket,
  predicate: (state: TurnState) => boolean
): Promise<TurnState> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const state = await getTurnState(ws);
    if (predicate(state)) return state;
    await waitForMicrotasks();
  }
  throw new Error("Timed out waiting for turn state");
}

async function waitForInterruptCount(
  ws: WebSocket,
  expectedCount: number
): Promise<{ interrupt: number; [key: string]: unknown }> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const counts = await getCounts(ws);
    if (counts.interrupt >= expectedCount) return counts;
    await waitForMicrotasks();
  }
  throw new Error(`Timed out waiting for ${expectedCount} interrupts`);
}

async function waitForTransportSendCount(
  ws: WebSocket,
  expectedCount: number
): Promise<string[]> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const events = await getTransportEvents(ws);
    const sends = events.filter((event) => event.startsWith("send:"));
    if (sends.length >= expectedCount) return events;
    await waitForMicrotasks();
  }
  throw new Error(`Timed out waiting for ${expectedCount} transport sends`);
}

function waitForBinary(ws: WebSocket, timeout = 5000): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      settled = true;
      clearTimeout(timer);
      ws.removeEventListener("message", handler);
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timeout waiting for binary message"));
    }, timeout);
    const handler = (e: MessageEvent) => {
      void toArrayBuffer(e.data).then(
        (buffer) => {
          if (settled || !buffer) return;
          cleanup();
          resolve(buffer);
        },
        (error: unknown) => {
          if (settled) return;
          cleanup();
          reject(error);
        }
      );
    };
    ws.addEventListener("message", handler);
  });
}

async function toArrayBuffer(data: unknown): Promise<ArrayBuffer | null> {
  if (data instanceof ArrayBuffer) return data;

  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice()
      .buffer as ArrayBuffer;
  }

  if (data instanceof Blob) return data.arrayBuffer();

  return null;
}

function decodeAudio(buffer: ArrayBuffer): string {
  return String.fromCharCode(...new Uint8Array(buffer));
}

function collectMessagesUntil(
  ws: WebSocket,
  predicate: (msg: Record<string, unknown>) => boolean,
  timeout = 5000
): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const messages: Record<string, unknown>[] = [];
    const timer = setTimeout(
      () => reject(new Error("Timeout collecting messages")),
      timeout
    );
    const handler = (e: MessageEvent) => {
      if (typeof e.data !== "string") return;

      const msg = JSON.parse(e.data) as Record<string, unknown>;
      messages.push(msg);
      if (predicate(msg)) {
        clearTimeout(timer);
        ws.removeEventListener("message", handler);
        resolve(messages);
      }
    };
    ws.addEventListener("message", handler);
  });
}

// --- Tests ---

describe("VoiceAgent — protocol", () => {
  it("sends idle status on connect", async () => {
    const { ws } = await connectWS(uniquePath());
    const msg = await waitForStatus(ws, "idle");
    expect(msg).toEqual({ type: "status", status: "idle" });
    ws.close();
  });

  it("sends listening status on start_call", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    const msg = await waitForStatus(ws, "listening");
    expect(msg).toEqual({ type: "status", status: "listening" });
    ws.close();
  });

  it("identifies recovered call starts", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");
    sendJSON(ws, { type: "end_call" });
    await waitForStatus(ws, "idle");
    sendJSON(ws, { type: "start_call", resumed: true });
    await waitForStatus(ws, "listening");

    expect(await getCounts(ws)).toMatchObject({
      callStart: 2,
      callStartResumed: [false, true]
    });
    ws.close();
  });

  it("drops inbound audio while the opening hook runs when configured", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "_hold_call_start" });
    await waitForAck(ws, "_hold_call_start");
    await startCall(ws);

    for (let i = 0; i < 4; i++) {
      ws.send(new ArrayBuffer(5000));
    }
    await waitForMicrotasks();
    expect((await getTurnState(ws)).transcripts).toEqual([]);

    sendJSON(ws, { type: "_release_call_start" });
    await waitForAck(ws, "_release_call_start");
    await waitForMicrotasks();

    const transcript = waitForMessageMatching(
      ws,
      (message) =>
        typeof message === "object" &&
        message !== null &&
        (message as Record<string, unknown>).type === "transcript" &&
        (message as Record<string, unknown>).role === "user"
    );
    for (let i = 0; i < 4; i++) {
      ws.send(new ArrayBuffer(5000));
    }
    expect((await transcript) as Record<string, unknown>).toMatchObject({
      text: "utterance 1 (20000 bytes)"
    });
    ws.close();
  });

  it("sends idle status on end_call", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    sendJSON(ws, { type: "end_call" });
    const msg = await waitForStatus(ws, "idle");
    expect(msg).toEqual({ type: "status", status: "idle" });
    ws.close();
  });

  it("sends audio_config on start_call", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    const config = (await waitForType(ws, "audio_config")) as Record<
      string,
      unknown
    >;
    expect(config.format).toBe("mp3");
    expect(config.sampleRate).toBe(16000);
    ws.close();
  });

  it("sends configured sampleRate in audio_config", async () => {
    const { ws } = await connectWS(
      `/agents/test-pcm24k-voice-agent/voice-test-${++instanceCounter}`
    );
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    const config = (await waitForType(ws, "audio_config")) as Record<
      string,
      unknown
    >;
    expect(config.format).toBe("pcm16");
    expect(config.sampleRate).toBe(24000);
    ws.close();
  });
});

describe("VoiceAgent — transcriber readiness", () => {
  it("does not send listening or run onCallStart before readiness resolves", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");
    await setTranscriberMode(ws, "pending_ready");

    const audioConfig = waitForType(ws, "audio_config");
    sendJSON(ws, { type: "start_call" });
    await audioConfig;

    const beforeReady = collectMessagesUntil(
      ws,
      (msg) => msg.type === "_counts"
    );
    sendJSON(ws, { type: "_get_counts" });

    const beforeReadyMessages = await beforeReady;
    expect(beforeReadyMessages).not.toContainEqual({
      type: "status",
      status: "listening"
    });
    expect(beforeReadyMessages.at(-1)).toMatchObject({
      type: "_counts",
      callStart: 0
    });

    sendJSON(ws, { type: "_resolve_transcriber_ready" });
    await waitForStatus(ws, "listening");

    sendJSON(ws, { type: "_get_counts" });
    const counts = (await waitForType(ws, "_counts")) as Record<
      string,
      unknown
    >;
    expect(counts.callStart).toBe(1);
    ws.close();
  });

  it("sends a visible error, returns idle, and cleans up when readiness rejects", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ws } = await connectWS(uniquePath());
    try {
      await waitForStatus(ws, "idle");
      await setTranscriberMode(ws, "reject_ready");

      const startupMessagesPromise = collectMessagesUntil(
        ws,
        (msg) => msg.type === "status" && msg.status === "idle"
      );
      sendJSON(ws, { type: "start_call" });
      const startupMessages = await startupMessagesPromise;

      expect(startupMessages).toContainEqual({
        type: "error",
        message: "Speech recognition failed to start: readiness failed"
      });
      expect(startupMessages.at(-1)).toEqual({
        type: "status",
        status: "idle"
      });

      sendJSON(ws, { type: "_get_counts" });
      const failedCounts = (await waitForType(ws, "_counts")) as Record<
        string,
        unknown
      >;
      expect(failedCounts.callStart).toBe(0);
      expect(failedCounts.callEnd).toBe(1);
      expect(failedCounts.keepAliveAcquired).toBe(1);
      expect(failedCounts.keepAliveReleased).toBe(1);

      await setTranscriberMode(ws, "default");
      sendJSON(ws, { type: "start_call" });
      await waitForStatus(ws, "listening");

      sendJSON(ws, { type: "_get_counts" });
      const restartedCounts = (await waitForType(ws, "_counts")) as Record<
        string,
        unknown
      >;
      expect(restartedCounts.callStart).toBe(1);
      expect(restartedCounts.callEnd).toBe(1);
      expect(restartedCounts.keepAliveAcquired).toBe(2);
      expect(restartedCounts.keepAliveReleased).toBe(1);
    } finally {
      ws.close();
      errorLog.mockRestore();
    }
  });

  it("sends a visible error, returns idle, and cleans up when session creation throws", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ws } = await connectWS(uniquePath());
    try {
      await waitForStatus(ws, "idle");
      await setTranscriberMode(ws, "create_throw");

      const startupMessagesPromise = collectMessagesUntil(
        ws,
        (msg) => msg.type === "status" && msg.status === "idle"
      );
      sendJSON(ws, { type: "start_call" });
      const startupMessages = await startupMessagesPromise;

      expect(startupMessages).toContainEqual({
        type: "error",
        message: "Speech recognition failed to start: create session failed"
      });
      expect(startupMessages.at(-1)).toEqual({
        type: "status",
        status: "idle"
      });

      sendJSON(ws, { type: "_get_counts" });
      const counts = (await waitForType(ws, "_counts")) as Record<
        string,
        unknown
      >;
      expect(counts.callStart).toBe(0);
      expect(counts.callEnd).toBe(1);
      expect(counts.keepAliveAcquired).toBe(1);
      expect(counts.keepAliveReleased).toBe(1);
    } finally {
      ws.close();
      errorLog.mockRestore();
    }
  });

  it("sends a visible error, returns idle, and cleans up when beforeCallStart throws", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ws } = await connectWS(uniquePath());
    try {
      await waitForStatus(ws, "idle");
      await setBeforeCallStart(ws, "throw");

      const startupMessagesPromise = collectMessagesUntil(
        ws,
        (msg) => msg.type === "status" && msg.status === "idle"
      );
      sendJSON(ws, { type: "start_call" });
      const startupMessages = await startupMessagesPromise;

      expect(startupMessages).toContainEqual({
        type: "error",
        message: "Voice call failed to start"
      });
      expect(startupMessages.at(-1)).toEqual({
        type: "status",
        status: "idle"
      });

      sendJSON(ws, { type: "_get_counts" });
      const failedCounts = (await waitForType(ws, "_counts")) as Record<
        string,
        unknown
      >;
      expect(failedCounts.callStart).toBe(0);
      expect(failedCounts.callEnd).toBe(1);
      expect(failedCounts.keepAliveAcquired).toBe(0);
      expect(failedCounts.keepAliveReleased).toBe(0);

      await setBeforeCallStart(ws, true);
      sendJSON(ws, { type: "start_call" });
      await waitForStatus(ws, "listening");

      sendJSON(ws, { type: "_get_counts" });
      const restartedCounts = (await waitForType(ws, "_counts")) as Record<
        string,
        unknown
      >;
      expect(restartedCounts.callStart).toBe(1);
      expect(restartedCounts.callEnd).toBe(1);
      expect(restartedCounts.keepAliveAcquired).toBe(1);
      expect(restartedCounts.keepAliveReleased).toBe(0);
    } finally {
      ws.close();
      errorLog.mockRestore();
    }
  });

  it("sends a visible error, returns idle, and cleans up when beforeCallStart rejects", async () => {
    const { ws } = await connectWS(uniquePath());
    try {
      await waitForStatus(ws, "idle");
      await setBeforeCallStart(ws, false);

      const startupMessagesPromise = collectMessagesUntil(
        ws,
        (msg) => msg.type === "status" && msg.status === "idle"
      );
      sendJSON(ws, { type: "start_call" });
      const startupMessages = await startupMessagesPromise;

      expect(startupMessages).toContainEqual({
        type: "error",
        message: "Voice call was rejected"
      });
      expect(startupMessages.at(-1)).toEqual({
        type: "status",
        status: "idle"
      });

      sendJSON(ws, { type: "_get_counts" });
      const failedCounts = (await waitForType(ws, "_counts")) as Record<
        string,
        unknown
      >;
      expect(failedCounts.callStart).toBe(0);
      expect(failedCounts.callEnd).toBe(1);
      expect(failedCounts.keepAliveAcquired).toBe(0);
      expect(failedCounts.keepAliveReleased).toBe(0);

      await setBeforeCallStart(ws, true);
      sendJSON(ws, { type: "start_call" });
      await waitForStatus(ws, "listening");

      sendJSON(ws, { type: "_get_counts" });
      const restartedCounts = (await waitForType(ws, "_counts")) as Record<
        string,
        unknown
      >;
      expect(restartedCounts.callStart).toBe(1);
      expect(restartedCounts.callEnd).toBe(1);
      expect(restartedCounts.keepAliveAcquired).toBe(1);
      expect(restartedCounts.keepAliveReleased).toBe(0);
    } finally {
      ws.close();
    }
  });

  it("sends a visible error, returns idle, and cleans up when no transcriber is configured", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ws } = await connectWS(uniquePath());
    try {
      await waitForStatus(ws, "idle");
      await setTranscriberMode(ws, "missing");

      const startupMessagesPromise = collectMessagesUntil(
        ws,
        (msg) => msg.type === "status" && msg.status === "idle"
      );
      sendJSON(ws, { type: "start_call" });
      const startupMessages = await startupMessagesPromise;

      expect(startupMessages).toContainEqual({
        type: "error",
        message:
          "No transcriber configured. Set 'transcriber' on your VoiceAgent subclass or override createTranscriber()."
      });
      expect(startupMessages.at(-1)).toEqual({
        type: "status",
        status: "idle"
      });

      sendJSON(ws, { type: "_get_counts" });
      const failedCounts = (await waitForType(ws, "_counts")) as Record<
        string,
        unknown
      >;
      expect(failedCounts.callStart).toBe(0);
      expect(failedCounts.callEnd).toBe(1);
      expect(failedCounts.keepAliveAcquired).toBe(1);
      expect(failedCounts.keepAliveReleased).toBe(1);

      await setTranscriberMode(ws, "default");
      sendJSON(ws, { type: "start_call" });
      await waitForStatus(ws, "listening");

      sendJSON(ws, { type: "_get_counts" });
      const restartedCounts = (await waitForType(ws, "_counts")) as Record<
        string,
        unknown
      >;
      expect(restartedCounts.callStart).toBe(1);
      expect(restartedCounts.callEnd).toBe(1);
      expect(restartedCounts.keepAliveAcquired).toBe(2);
      expect(restartedCounts.keepAliveReleased).toBe(1);
    } finally {
      ws.close();
      errorLog.mockRestore();
    }
  });

  it("sends a visible error, returns idle, and cleans up when keepAlive rejects", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ws } = await connectWS(uniquePath());
    try {
      await waitForStatus(ws, "idle");
      await setKeepAliveThrow(ws, true);

      const startupMessagesPromise = collectMessagesUntil(
        ws,
        (msg) => msg.type === "status" && msg.status === "idle"
      );
      sendJSON(ws, { type: "start_call" });
      const startupMessages = await startupMessagesPromise;

      expect(startupMessages).toContainEqual({
        type: "error",
        message: "Voice call failed to start"
      });
      expect(startupMessages.at(-1)).toEqual({
        type: "status",
        status: "idle"
      });

      sendJSON(ws, { type: "_get_counts" });
      const failedCounts = (await waitForType(ws, "_counts")) as Record<
        string,
        unknown
      >;
      expect(failedCounts.callStart).toBe(0);
      expect(failedCounts.callEnd).toBe(1);
      expect(failedCounts.keepAliveAcquired).toBe(0);
      expect(failedCounts.keepAliveReleased).toBe(0);

      await setKeepAliveThrow(ws, false);
      sendJSON(ws, { type: "start_call" });
      await waitForStatus(ws, "listening");

      sendJSON(ws, { type: "_get_counts" });
      const restartedCounts = (await waitForType(ws, "_counts")) as Record<
        string,
        unknown
      >;
      expect(restartedCounts.callStart).toBe(1);
      expect(restartedCounts.callEnd).toBe(1);
      expect(restartedCounts.keepAliveAcquired).toBe(1);
      expect(restartedCounts.keepAliveReleased).toBe(0);
    } finally {
      ws.close();
      errorLog.mockRestore();
    }
  });

  it("ignores stale readiness after end_call", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");
    await setTranscriberMode(ws, "pending_ready");

    sendJSON(ws, { type: "start_call" });
    await waitForType(ws, "audio_config");

    sendJSON(ws, { type: "end_call" });
    await waitForStatus(ws, "idle");

    const afterEnd = collectMessagesUntil(ws, (msg) => msg.type === "_counts");
    sendJSON(ws, { type: "_resolve_transcriber_ready" });
    sendJSON(ws, { type: "_get_counts" });
    const afterEndMessages = await afterEnd;

    expect(afterEndMessages).not.toContainEqual({
      type: "status",
      status: "listening"
    });
    expect(afterEndMessages.some((msg) => msg.type === "error")).toBe(false);
    expect(afterEndMessages.at(-1)).toMatchObject({
      type: "_counts",
      callStart: 0,
      callEnd: 1,
      keepAliveAcquired: 1,
      keepAliveReleased: 1
    });
    ws.close();
  });

  it("ignores stale readiness rejection after end_call", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");
    await setTranscriberMode(ws, "pending_ready_no_close_settle");

    sendJSON(ws, { type: "start_call" });
    await waitForType(ws, "audio_config");

    sendJSON(ws, { type: "end_call" });
    await waitForStatus(ws, "idle");

    const afterEnd = collectMessagesUntil(ws, (msg) => msg.type === "_counts");
    sendJSON(ws, { type: "_reject_transcriber_ready" });
    await waitForMicrotasks();
    sendJSON(ws, { type: "_get_counts" });
    const afterEndMessages = await afterEnd;

    expect(afterEndMessages).not.toContainEqual({
      type: "status",
      status: "listening"
    });
    expect(afterEndMessages.some((msg) => msg.type === "error")).toBe(false);
    expect(afterEndMessages.at(-1)).toMatchObject({
      type: "_counts",
      callStart: 0,
      callEnd: 1,
      keepAliveAcquired: 1,
      keepAliveReleased: 1
    });
    ws.close();
  });

  it("ignores stale readiness rejection after a later startup succeeds", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");
    await setTranscriberMode(ws, "pending_ready_no_close_settle");

    sendJSON(ws, { type: "start_call" });
    await waitForType(ws, "audio_config");

    sendJSON(ws, { type: "end_call" });
    await waitForStatus(ws, "idle");

    await setTranscriberMode(ws, "default");
    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    const afterRestart = collectMessagesUntil(
      ws,
      (msg) => msg.type === "_counts"
    );
    sendJSON(ws, { type: "_reject_transcriber_ready_at", index: 0 });
    await waitForMicrotasks();
    sendJSON(ws, { type: "_get_counts" });
    const afterRestartMessages = await afterRestart;

    expect(afterRestartMessages.some((msg) => msg.type === "error")).toBe(
      false
    );
    expect(afterRestartMessages.at(-1)).toMatchObject({
      type: "_counts",
      callStart: 1,
      callEnd: 1,
      keepAliveAcquired: 2,
      keepAliveReleased: 1
    });
    ws.close();
  });

  it("ignores stale readiness rejection after disconnect", async () => {
    const path = uniquePath();
    const { ws } = await connectWS(path);
    await waitForStatus(ws, "idle");
    await setTranscriberMode(ws, "pending_ready_no_close_settle");

    sendJSON(ws, { type: "start_call" });
    await waitForType(ws, "audio_config");

    ws.close();
    await waitForMicrotasks();

    const { ws: nextWs } = await connectWS(path);
    await waitForStatus(nextWs, "idle");

    const afterDisconnect = collectMessagesUntil(
      nextWs,
      (msg) => msg.type === "_counts"
    );
    sendJSON(nextWs, { type: "_reject_transcriber_ready" });
    await waitForMicrotasks();
    sendJSON(nextWs, { type: "_get_counts" });
    const afterDisconnectMessages = await afterDisconnect;

    expect(afterDisconnectMessages).not.toContainEqual({
      type: "status",
      status: "listening"
    });
    expect(afterDisconnectMessages.some((msg) => msg.type === "error")).toBe(
      false
    );
    expect(afterDisconnectMessages.at(-1)).toMatchObject({
      type: "_counts",
      callStart: 0,
      keepAliveAcquired: 1,
      keepAliveReleased: 1
    });
    nextWs.close();
  });

  it("starts immediately for custom transcribers without waitUntilReady", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    sendJSON(ws, { type: "_get_counts" });
    const counts = (await waitForType(ws, "_counts")) as Record<
      string,
      unknown
    >;
    expect(counts.callStart).toBe(1);
    ws.close();
  });
});

describe("VoiceAgent — continuous STT pipeline", () => {
  it("transcribes audio and echoes back via onTurn", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    // Send enough audio to trigger utterance (20000 bytes)
    for (let i = 0; i < 4; i++) {
      ws.send(new ArrayBuffer(5000));
    }

    // Wait for user transcript
    const transcript = (await waitForMessageMatching(
      ws,
      (m) =>
        typeof m === "object" &&
        m !== null &&
        (m as Record<string, unknown>).type === "transcript" &&
        (m as Record<string, unknown>).role === "user"
    )) as Record<string, unknown>;

    expect((transcript.text as string).includes("utterance 1")).toBe(true);

    // Wait for assistant echo
    const transcriptEnd = (await waitForType(ws, "transcript_end")) as Record<
      string,
      unknown
    >;
    expect((transcriptEnd.text as string).includes("Echo:")).toBe(true);

    ws.close();
  });

  it("logs the finalized transcript exactly as sent to the client", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { ws } = await connectWS(uniquePath());

    try {
      await waitForStatus(ws, "idle");
      sendJSON(ws, { type: "start_call" });
      await waitForStatus(ws, "listening");

      sendJSON(ws, { type: "text_message", text: "logging test" });
      await waitForType(ws, "transcript_end");

      expect(log).toHaveBeenCalledWith("[VoiceTrace]", {
        event: "client_transcript",
        connectionId: expect.any(String),
        role: "user",
        text: "logging test"
      });
      expect(log).toHaveBeenCalledWith("[VoiceTrace]", {
        event: "client_transcript",
        connectionId: expect.any(String),
        role: "assistant",
        text: "Echo: logging test"
      });
    } finally {
      ws.close();
      log.mockRestore();
    }
  });

  it("sends interim transcripts during audio streaming", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    ws.send(new ArrayBuffer(5000));

    const interim = (await waitForType(ws, "transcript_interim")) as Record<
      string,
      unknown
    >;
    expect(interim.text).toBeDefined();
    expect((interim.text as string).includes("hearing")).toBe(true);

    ws.close();
  });

  it("clears interim transcript before emitting final", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    for (let i = 0; i < 4; i++) {
      ws.send(new ArrayBuffer(5000));
    }

    // Should get interim clear (empty text) before the user transcript
    const cleared = (await waitForMessageMatching(
      ws,
      (m) =>
        typeof m === "object" &&
        m !== null &&
        (m as Record<string, unknown>).type === "transcript_interim" &&
        (m as Record<string, unknown>).text === ""
    )) as Record<string, unknown>;
    expect(cleared.text).toBe("");

    ws.close();
  });

  it("sends pipeline metrics after processing", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    for (let i = 0; i < 4; i++) {
      ws.send(new ArrayBuffer(5000));
    }

    const metrics = (await waitForType(ws, "metrics")) as Record<
      string,
      unknown
    >;
    expect(metrics).toHaveProperty("llm_ms");
    expect(metrics).toHaveProperty("tts_ms");
    expect(metrics).toHaveProperty("first_model_delta_ms");
    expect(metrics).toHaveProperty("first_sentence_ms");
    expect(metrics).toHaveProperty("first_audio_ms");
    expect(metrics).toHaveProperty("total_ms");
    expect(metrics).not.toHaveProperty("vad_ms");
    expect(metrics).not.toHaveProperty("stt_ms");

    ws.close();
  });

  it("sends thinking status before speaking during voice pipeline", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    for (let i = 0; i < 4; i++) {
      ws.send(new ArrayBuffer(5000));
    }

    // Should see thinking before speaking
    await waitForStatus(ws, "thinking");
    await waitForStatus(ws, "speaking");

    // Should eventually get back to listening
    await waitForStatus(ws, "listening");

    ws.close();
  });

  it("handles AI SDK stream responses that include tool calls", async () => {
    const { ws } = await connectWS(uniqueAISDKStreamPath());
    await waitForStatus(ws, "idle");

    const mockResponse = [
      [
        { type: "text", text: "I can get the weather for you." },
        {
          type: "tool-call",
          toolName: "getWeather",
          input: { location: "San Francisco" },
          output: "warm"
        }
      ],
      [{ type: "text", text: "The weather is warm" }]
    ];
    sendJSON(ws, { type: "_set_mock_response", response: mockResponse });
    await waitForMessageMatching(
      ws,
      (m) =>
        typeof m === "object" &&
        m !== null &&
        (m as Record<string, unknown>).type === "_ack" &&
        (m as Record<string, unknown>).command === "_set_mock_response"
    );

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    for (let i = 0; i < 4; i++) {
      ws.send(new ArrayBuffer(5000));
    }

    const transcriptEnd = (await waitForType(ws, "transcript_end")) as Record<
      string,
      unknown
    >;
    expect(transcriptEnd.text).toBe(
      "I can get the weather for you. The weather is warm"
    );

    await waitForStatus(ws, "listening");
    ws.close();
  });

  it("speaks stream text before delayed tool results complete", async () => {
    const { ws } = await connectWS(uniqueAISDKStreamPath());
    await waitForStatus(ws, "idle");

    const mockResponse = [
      [
        { type: "text", text: "I can get the weather for you." },
        {
          type: "tool-call",
          toolName: "getWeather",
          input: { location: "San Francisco" },
          output: "warm",
          outputDelayMs: 3000
        }
      ],
      [{ type: "text", text: "The weather is warm" }]
    ];
    sendJSON(ws, { type: "_set_mock_response", response: mockResponse });
    await waitForMessageMatching(
      ws,
      (m) =>
        typeof m === "object" &&
        m !== null &&
        (m as Record<string, unknown>).type === "_ack" &&
        (m as Record<string, unknown>).command === "_set_mock_response"
    );

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    const audioPromise = waitForBinary(ws, 1000);
    for (let i = 0; i < 4; i++) {
      ws.send(new ArrayBuffer(5000));
    }

    const audio = await audioPromise;
    expect(decodeAudio(audio)).toBe("I can get the weather for you.");

    const transcriptEnd = (await waitForType(ws, "transcript_end")) as Record<
      string,
      unknown
    >;
    expect(transcriptEnd.text).toBe(
      "I can get the weather for you. The weather is warm"
    );

    await waitForStatus(ws, "listening");
    ws.close();
  });

  it("flushes partial stream speech before reporting stream errors", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ws } = await connectWS(uniqueAISDKStreamPath());
    try {
      await waitForStatus(ws, "idle");

      const mockResponse = [
        [
          { type: "text", text: "Partial response." },
          { type: "error", message: "provider failed" }
        ]
      ];
      sendJSON(ws, { type: "_set_mock_response", response: mockResponse });
      await waitForMessageMatching(
        ws,
        (m) =>
          typeof m === "object" &&
          m !== null &&
          (m as Record<string, unknown>).type === "_ack" &&
          (m as Record<string, unknown>).command === "_set_mock_response"
      );

      sendJSON(ws, { type: "start_call" });
      await waitForStatus(ws, "listening");

      const audioPromise = waitForBinary(ws, 1000);
      for (let i = 0; i < 4; i++) {
        ws.send(new ArrayBuffer(5000));
      }

      const audio = await audioPromise;
      expect(decodeAudio(audio)).toBe("Partial response.");

      const transcriptEnd = (await waitForType(ws, "transcript_end")) as Record<
        string,
        unknown
      >;
      expect(transcriptEnd.text).toBe("Partial response.");

      const error = (await waitForType(ws, "error")) as Record<string, unknown>;
      expect(error.message).toBe("provider failed");

      await waitForStatus(ws, "listening");
    } finally {
      ws.close();
      errorLog.mockRestore();
    }
  });

  it("keeps deprecated AI SDK textStream support for tool-call streams", async () => {
    const { ws } = await connectWS(uniqueAISDKTextStreamPath());
    await waitForStatus(ws, "idle");

    const mockResponse = [
      [
        { type: "text", text: "I can get the weather for you." },
        {
          type: "tool-call",
          toolName: "getWeather",
          input: { location: "San Francisco" },
          output: "warm"
        }
      ],
      [{ type: "text", text: "The weather is warm" }]
    ];
    sendJSON(ws, { type: "_set_mock_response", response: mockResponse });
    await waitForMessageMatching(
      ws,
      (m) =>
        typeof m === "object" &&
        m !== null &&
        (m as Record<string, unknown>).type === "_ack" &&
        (m as Record<string, unknown>).command === "_set_mock_response"
    );

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    for (let i = 0; i < 4; i++) {
      ws.send(new ArrayBuffer(5000));
    }

    const transcriptEnd = (await waitForType(ws, "transcript_end")) as Record<
      string,
      unknown
    >;
    // Known textStream bug: AI SDK textStream omits the boundary between
    // non-adjacent text parts separated by tool calls. Keep coverage so we
    // notice if deprecated textStream support stops working entirely.
    expect(transcriptEnd.text).toBe(
      "I can get the weather for you.The weather is warm"
    );

    await waitForStatus(ws, "listening");
    ws.close();
  });
});

describe("VoiceAgent — turn context history", () => {
  it("gives text turns completed history without the current transcript", async () => {
    const { ws } = await connectWS(uniqueContextPath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "text_message", text: "first text turn" });
    const firstResponse = (await waitForType(ws, "transcript_end")) as Record<
      string,
      unknown
    >;
    expect(firstResponse.text).toBe("[]");

    sendJSON(ws, { type: "text_message", text: "second text turn" });
    const secondResponse = (await waitForType(ws, "transcript_end")) as Record<
      string,
      unknown
    >;
    expect(JSON.parse(secondResponse.text as string)).toEqual([
      { role: "user", content: "first text turn" },
      { role: "assistant", content: "[]" }
    ]);

    ws.close();
  });

  it("gives audio turns completed history without the current transcript", async () => {
    const { ws } = await connectWS(uniqueContextPath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    for (let i = 0; i < 4; i++) {
      ws.send(new ArrayBuffer(5000));
    }

    const firstResponse = (await waitForType(ws, "transcript_end")) as Record<
      string,
      unknown
    >;
    expect(firstResponse.text).toBe("[]");
    await waitForStatus(ws, "listening");

    for (let i = 0; i < 4; i++) {
      ws.send(new ArrayBuffer(5000));
    }

    const secondResponse = (await waitForType(ws, "transcript_end")) as Record<
      string,
      unknown
    >;
    expect(JSON.parse(secondResponse.text as string)).toEqual([
      { role: "user", content: "utterance 1 (20000 bytes)" },
      { role: "assistant", content: "[]" }
    ]);

    ws.close();
  });
});

describe("VoiceAgent — agent context carryover", () => {
  it("feeds the assistant's spoken reply back to the transcriber session", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    for (let i = 0; i < 4; i++) {
      ws.send(new ArrayBuffer(5000));
    }

    // Wait for the assistant reply to finish and the pipeline to settle.
    await waitForType(ws, "transcript_end");
    await waitForStatus(ws, "listening");

    sendJSON(ws, { type: "_get_agent_context" });
    const ctx = (await waitForType(ws, "_agent_context")) as Record<
      string,
      unknown
    >;
    const contexts = ctx.contexts as string[];
    expect(contexts).toContain("Echo: utterance 1 (20000 bytes)");

    ws.close();
  });
});

describe("VoiceAgent — multi-turn", () => {
  it("handles second utterance after first pipeline completes", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    // First utterance
    for (let i = 0; i < 4; i++) {
      ws.send(new ArrayBuffer(5000));
    }

    await waitForMessageMatching(
      ws,
      (m) =>
        typeof m === "object" &&
        m !== null &&
        (m as Record<string, unknown>).type === "transcript" &&
        (m as Record<string, unknown>).role === "user"
    );

    // Wait for pipeline to complete (back to listening)
    await waitForStatus(ws, "listening");

    // Second utterance (need another 20000 bytes, total 40000)
    for (let i = 0; i < 4; i++) {
      ws.send(new ArrayBuffer(5000));
    }

    const transcript = (await waitForMessageMatching(
      ws,
      (m) =>
        typeof m === "object" &&
        m !== null &&
        (m as Record<string, unknown>).type === "transcript" &&
        (m as Record<string, unknown>).role === "user"
    )) as Record<string, unknown>;

    expect((transcript.text as string).includes("utterance 2")).toBe(true);

    ws.close();
  });

  it("retains conversation messages across turns in memory", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    for (let i = 0; i < 4; i++) {
      ws.send(new ArrayBuffer(5000));
    }

    // Wait for full pipeline (user + assistant)
    await waitForMessageMatching(
      ws,
      (m) =>
        typeof m === "object" &&
        m !== null &&
        (m as Record<string, unknown>).type === "transcript_end"
    );

    await waitForStatus(ws, "listening");

    // Check message count
    sendJSON(ws, { type: "_get_message_count" });
    const count = (await waitForType(ws, "_message_count")) as Record<
      string,
      unknown
    >;
    expect(count.count).toBe(2); // user + assistant

    ws.close();
  });
});
describe("VoiceAgent — speculative turn lifecycle", () => {
  it("starts eager work without releasing draft output", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");
    await startCall(ws);
    const recording = recordSocket(ws);

    sendJSON(ws, { type: "_emit_eager", text: "draft question" });
    const state = await waitUntilTurnState(
      ws,
      (value) => value.transcripts.length === 1
    );
    await waitForMicrotasks();

    expect(state).toEqual({
      transcripts: ["draft question"],
      abortCount: 0
    });
    expect(await getMessageCount(ws)).toBe(0);
    const releasedTypes = new Set([
      "status",
      "transcript",
      "transcript_start",
      "transcript_delta",
      "transcript_end",
      "metrics",
      "error",
      "playback_interrupt"
    ]);
    expect(
      recording.messages.filter((message) =>
        releasedTypes.has(String(message.type))
      )
    ).toEqual([]);
    expect(recording.binaryCount).toBe(0);

    recording.stop();
    ws.close();
  });

  it("reuses a matching eager turn and keeps one exchange", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");
    await startCall(ws);
    const recording = recordSocket(ws);

    sendJSON(ws, { type: "_emit_eager", text: "matching question" });
    await waitUntilTurnState(ws, (state) => state.transcripts.length === 1);

    const responseDone = waitForType(ws, "transcript_end");
    const listening = waitForStatus(ws, "listening");
    sendJSON(ws, { type: "_emit_end", text: "matching question" });
    await responseDone;
    await listening;

    expect(await getTurnState(ws)).toEqual({
      transcripts: ["matching question"],
      abortCount: 0
    });
    expect(await getMessageCount(ws)).toBe(2);
    expect(
      recording.messages.filter(
        (message) => message.type === "transcript" && message.role === "user"
      )
    ).toHaveLength(1);
    expect(
      recording.messages.filter((message) => message.type === "transcript_end")
    ).toHaveLength(1);
    expect(recording.binaryCount).toBe(1);

    recording.stop();
    ws.close();
  });

  it("persists a confirmed eager transcript before the turn settles", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");
    await setTurnMode(ws, "until_abort");
    await startCall(ws);

    sendJSON(ws, { type: "_emit_eager", text: "confirmed question" });
    await waitUntilTurnState(ws, (state) => state.transcripts.length === 1);

    const transcript = waitForMessageMatching(
      ws,
      (message) =>
        typeof message === "object" &&
        message !== null &&
        (message as Record<string, unknown>).type === "transcript" &&
        (message as Record<string, unknown>).role === "user"
    );
    sendJSON(ws, { type: "_emit_end", text: "confirmed question" });

    await expect(transcript).resolves.toMatchObject({
      text: "confirmed question"
    });
    expect(await getMessageCount(ws)).toBe(1);

    ws.close();
  });

  it("silently cancels an eager turn when speech resumes", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");
    await startCall(ws);
    const recording = recordSocket(ws);

    sendJSON(ws, { type: "_emit_eager", text: "unfinished question" });
    await waitUntilTurnState(ws, (state) => state.transcripts.length === 1);
    sendJSON(ws, { type: "_emit_turn_resumed", text: "unfinished question" });
    const state = await waitUntilTurnState(
      ws,
      (value) => value.abortCount === 1
    );
    await waitForMicrotasks();

    expect(state.transcripts).toEqual(["unfinished question"]);
    expect(await getMessageCount(ws)).toBe(0);
    expect((await getCounts(ws)).interrupt).toBe(0);
    expect(
      recording.messages.filter((message) =>
        [
          "playback_interrupt",
          "error",
          "transcript",
          "transcript_start",
          "transcript_delta",
          "transcript_end"
        ].includes(String(message.type))
      )
    ).toEqual([]);
    expect(recording.binaryCount).toBe(0);

    recording.stop();
    ws.close();
  });

  it("restarts from mismatched final text without releasing the draft", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");
    await startCall(ws);
    const recording = recordSocket(ws);

    sendJSON(ws, { type: "_emit_eager", text: "draft text" });
    await waitUntilTurnState(ws, (state) => state.transcripts.length === 1);

    const responseDone = waitForType(ws, "transcript_end");
    const listening = waitForStatus(ws, "listening");
    sendJSON(ws, { type: "_emit_end", text: "final text" });
    await responseDone;
    await listening;

    expect(await getTurnState(ws)).toEqual({
      transcripts: ["draft text", "final text"],
      abortCount: 1
    });
    expect(await getMessageCount(ws)).toBe(2);
    const userMessages = recording.messages.filter(
      (message) => message.type === "transcript" && message.role === "user"
    );
    expect(userMessages.map((message) => message.text)).toEqual(["final text"]);
    const assistantMessages = recording.messages.filter(
      (message) => message.type === "transcript_end"
    );
    expect(assistantMessages.map((message) => message.text)).toEqual([
      "Echo: final text"
    ]);

    recording.stop();
    ws.close();
  });

  it("suppresses rejected cancelled drafts and surfaces confirmed failures", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const first = await connectWS(uniquePath());
    let secondWs: WebSocket | null = null;
    try {
      await waitForStatus(first.ws, "idle");
      await setTurnMode(first.ws, "reject");
      await startCall(first.ws);
      const cancelledRecording = recordSocket(first.ws);

      sendJSON(first.ws, { type: "_emit_eager", text: "cancelled failure" });
      await waitUntilTurnState(
        first.ws,
        (state) => state.transcripts.length === 1
      );
      sendJSON(first.ws, { type: "_emit_turn_resumed" });
      await waitUntilTurnState(first.ws, (state) => state.abortCount === 1);
      await waitForMicrotasks();

      expect(await getMessageCount(first.ws)).toBe(0);
      expect(
        cancelledRecording.messages.filter(
          (message) => message.type === "error"
        )
      ).toEqual([]);
      expect(errorLog).not.toHaveBeenCalled();

      first.ws.close();
      const second = await connectWS(uniquePath());
      secondWs = second.ws;
      await waitForStatus(second.ws, "idle");
      await setTurnMode(second.ws, "reject");
      await startCall(second.ws);
      const confirmedRecording = recordSocket(second.ws);

      sendJSON(second.ws, { type: "_emit_eager", text: "confirmed failure" });
      await waitUntilTurnState(
        second.ws,
        (state) => state.transcripts.length === 1
      );
      const error = waitForType(second.ws, "error");
      const listening = waitForStatus(second.ws, "listening");
      sendJSON(second.ws, {
        type: "_emit_end",
        text: "confirmed failure"
      });
      await error;
      await listening;

      expect(await getMessageCount(second.ws)).toBe(1);
      expect(
        confirmedRecording.messages.filter(
          (message) => message.type === "error"
        )
      ).toHaveLength(1);
      expect(
        confirmedRecording.messages.filter((message) =>
          ["transcript_start", "transcript_delta", "transcript_end"].includes(
            String(message.type)
          )
        )
      ).toEqual([]);
      expect(errorLog).toHaveBeenCalledTimes(1);
    } finally {
      first.ws.close();
      secondWs?.close();
      errorLog.mockRestore();
    }
  });

  it("aborts pending eager work on end call and WebSocket close", async () => {
    const ended = await connectWS(uniquePath());
    await waitForStatus(ended.ws, "idle");
    await setTurnMode(ended.ws, "until_abort");
    await startCall(ended.ws);
    const endedRecording = recordSocket(ended.ws);

    sendJSON(ended.ws, { type: "_emit_eager", text: "pending end call" });
    await waitUntilTurnState(
      ended.ws,
      (state) => state.transcripts.length === 1
    );
    const idle = waitForStatus(ended.ws, "idle");
    sendJSON(ended.ws, { type: "end_call" });
    await idle;
    expect(
      await waitUntilTurnState(ended.ws, (state) => state.abortCount === 1)
    ).toEqual({
      transcripts: ["pending end call"],
      abortCount: 1
    });
    expect(await getMessageCount(ended.ws)).toBe(0);
    expect(
      endedRecording.messages.filter((message) =>
        [
          "transcript",
          "transcript_start",
          "transcript_delta",
          "transcript_end",
          "error",
          "playback_interrupt"
        ].includes(String(message.type))
      )
    ).toEqual([]);
    ended.ws.close();

    const instanceName = `voice-test-${crypto.randomUUID()}`;
    const closed = await connectWS(`/agents/test-voice-agent/${instanceName}`);
    await waitForStatus(closed.ws, "idle");
    await setTurnMode(closed.ws, "until_abort");
    await startCall(closed.ws);
    const closedRecording = recordSocket(closed.ws);
    sendJSON(closed.ws, {
      type: "_emit_eager",
      text: "pending connection close"
    });
    await waitUntilTurnState(
      closed.ws,
      (state) => state.transcripts.length === 1
    );
    closed.ws.close();

    const stub = env.TestVoiceAgent.get(
      env.TestVoiceAgent.idFromName(instanceName)
    ) as DurableObjectStub<TestVoiceAgent>;
    const closedState = await runInDurableObject(stub, (instance) => ({
      turn: instance.getTurnStateForTest(),
      messageCount: instance.getMessageCount()
    }));
    expect(closedState).toEqual({
      turn: {
        transcripts: ["pending connection close"],
        abortCount: 1
      },
      messageCount: 0
    });
    expect(
      closedRecording.messages.filter((message) =>
        [
          "transcript",
          "transcript_start",
          "transcript_delta",
          "transcript_end",
          "error",
          "playback_interrupt"
        ].includes(String(message.type))
      )
    ).toEqual([]);
  });

  it("supports eager resume eager confirm without stale state", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");
    await startCall(ws);
    const recording = recordSocket(ws);

    sendJSON(ws, { type: "_emit_eager", text: "first draft" });
    await waitUntilTurnState(ws, (state) => state.transcripts.length === 1);
    sendJSON(ws, { type: "_emit_turn_resumed" });
    await waitUntilTurnState(ws, (state) => state.abortCount === 1);

    sendJSON(ws, { type: "_emit_eager", text: "second draft" });
    await waitUntilTurnState(ws, (state) => state.transcripts.length === 2);
    const responseDone = waitForType(ws, "transcript_end");
    const listening = waitForStatus(ws, "listening");
    sendJSON(ws, { type: "_emit_end", text: "second draft" });
    await responseDone;
    await listening;

    expect(await getTurnState(ws)).toEqual({
      transcripts: ["first draft", "second draft"],
      abortCount: 1
    });
    expect(await getMessageCount(ws)).toBe(2);
    const users = recording.messages.filter(
      (message) => message.type === "transcript" && message.role === "user"
    );
    expect(users.map((message) => message.text)).toEqual(["second draft"]);
    expect(
      recording.messages.filter((message) => message.type === "transcript_end")
    ).toHaveLength(1);

    recording.stop();
    ws.close();
  });

  it("interrupts controlled streaming audio after an eager transcript", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");
    sendJSON(ws, { type: "_set_audio_transport", value: true });
    await waitForAck(ws, "_set_audio_transport");
    await setTtsMode(ws, "controlled");
    await startCall(ws);
    const recording = recordSocket(ws);

    sendJSON(ws, { type: "_emit_end", text: "confirmed audio" });
    await waitForTransportSendCount(ws, 1);

    const playbackInterrupt = waitForType(ws, "playback_interrupt");
    ws.send(new ArrayBuffer(1));
    await playbackInterrupt;
    await waitForMicrotasks();
    expect(await getMessageCount(ws)).toBe(1);

    sendJSON(ws, { type: "_emit_eager", text: "real interruption" });
    sendJSON(ws, { type: "_emit_end", text: "real interruption" });
    const events = await waitForTransportEventCount(ws, "interrupt", 1);
    const counts = await waitForInterruptCount(ws, 1);

    expect(
      recording.messages.filter(
        (message) => message.type === "playback_interrupt"
      )
    ).toHaveLength(1);
    expect(events.filter((event) => event === "interrupt")).toHaveLength(1);
    expect(counts.interrupt).toBe(1);
    expect((await getTurnState(ws)).abortCount).toBe(1);

    recording.stop();
    ws.close();
  });

  it("rejects active assistant echo before accepting real barge-in", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");
    sendJSON(ws, { type: "_set_audio_transport", value: true });
    await waitForAck(ws, "_set_audio_transport");
    await setTtsMode(ws, "controlled");
    await startCall(ws);
    const recording = recordSocket(ws);

    sendJSON(ws, { type: "_emit_end", text: "confirmed audio" });
    await waitForTransportSendCount(ws, 1);

    sendJSON(ws, { type: "_emit_eager", text: "Echo confirmed audio" });
    sendJSON(ws, { type: "_emit_end", text: "Echo confirmed audio" });
    await waitForMicrotasks();

    expect((await getCounts(ws)).interrupt).toBe(0);
    expect(await getTurnState(ws)).toEqual({
      transcripts: ["confirmed audio"],
      abortCount: 0
    });
    expect(await getMessageCount(ws)).toBe(1);
    expect(
      recording.messages.filter(
        (message) => message.type === "playback_interrupt"
      )
    ).toHaveLength(0);

    sendJSON(ws, { type: "_emit_eager", text: "real interruption" });
    sendJSON(ws, { type: "_emit_end", text: "real interruption" });

    expect((await waitForInterruptCount(ws, 1)).interrupt).toBe(1);
    expect(
      recording.messages.filter(
        (message) => message.type === "playback_interrupt"
      )
    ).toHaveLength(1);

    recording.stop();
    ws.close();
  });
});

describe("VoiceAgent — interrupt", () => {
  it("aborts an active pipeline when speech starts", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "_set_turn_delay", value: 1000 });
    await waitForType(ws, "_ack");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    sendJSON(ws, { type: "text_message", text: "long response" });
    await waitForStatus(ws, "thinking");

    const playbackInterrupt = waitForType(ws, "playback_interrupt");
    ws.send(new ArrayBuffer(5000));
    expect(await playbackInterrupt).toEqual({ type: "playback_interrupt" });
    expect((await waitForInterruptCount(ws, 1)).interrupt).toBe(1);

    const transcript = waitForMessageMatching(
      ws,
      (message) =>
        typeof message === "object" &&
        message !== null &&
        (message as Record<string, unknown>).type === "transcript" &&
        (message as Record<string, unknown>).role === "user"
    );
    for (let i = 0; i < 3; i++) {
      ws.send(new ArrayBuffer(5000));
    }

    expect(((await transcript) as Record<string, unknown>).text).toBe(
      "utterance 1 (20000 bytes)"
    );

    ws.close();
  });

  it("interrupts each active pipeline without a cooldown", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");
    await setTurnMode(ws, "until_abort");
    await startCall(ws);

    sendJSON(ws, { type: "text_message", text: "long response 1" });
    await waitForStatus(ws, "thinking");
    const firstInterrupt = waitForType(ws, "playback_interrupt");
    ws.send(new ArrayBuffer(1));
    await firstInterrupt;
    expect((await waitForInterruptCount(ws, 1)).interrupt).toBe(1);

    sendJSON(ws, { type: "text_message", text: "long response 2" });
    await waitForStatus(ws, "thinking");
    const secondInterrupt = waitForType(ws, "playback_interrupt");
    ws.send(new ArrayBuffer(1));
    await secondInterrupt;
    expect((await waitForInterruptCount(ws, 2)).interrupt).toBe(2);

    ws.close();
  });

  it("does not count model-detected speech as interrupt while already listening", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    ws.send(new ArrayBuffer(5000));
    await waitForType(ws, "transcript_interim");

    sendJSON(ws, { type: "_get_counts" });
    const counts = (await waitForType(ws, "_counts")) as Record<
      string,
      unknown
    >;
    expect(counts.interrupt).toBe(0);

    ws.close();
  });

  it("aborts pipeline on interrupt but session survives for next turn", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    // Send some audio, then interrupt before utterance threshold
    ws.send(new ArrayBuffer(10000));
    sendJSON(ws, { type: "interrupt" });
    await waitForStatus(ws, "listening");

    // Session should still be alive — send more audio to reach threshold
    ws.send(new ArrayBuffer(10000));

    // Should still get a transcript because the session survived
    const transcript = (await waitForMessageMatching(
      ws,
      (m) =>
        typeof m === "object" &&
        m !== null &&
        (m as Record<string, unknown>).type === "transcript" &&
        (m as Record<string, unknown>).role === "user"
    )) as Record<string, unknown>;

    expect((transcript.text as string).includes("utterance 1")).toBe(true);

    ws.close();
  });

  it("counts interrupts", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    sendJSON(ws, { type: "interrupt" });
    await waitForStatus(ws, "listening");

    sendJSON(ws, { type: "_get_counts" });
    const counts = (await waitForType(ws, "_counts")) as Record<
      string,
      unknown
    >;
    expect(counts.interrupt).toBe(1);

    ws.close();
  });

  it("gates eager transcript barge-in below minInterruptWords", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { ws } = await connectWS(uniqueMinInterruptPath());
    const recording = recordSocket(ws);
    try {
      await waitForStatus(ws, "idle");
      await startCall(ws);

      sendJSON(ws, { type: "text_message", text: "long response" });
      await waitForStatus(ws, "thinking");
      expect(
        await waitUntilTurnState(ws, (state) => state.transcripts.length === 1)
      ).toEqual({
        transcripts: ["long response"],
        abortCount: 0
      });

      for (const transcript of ["no", "no way"]) {
        sendJSON(ws, { type: "_emit_speech_start", text: transcript });
        sendJSON(ws, { type: "_emit_eager", text: transcript });
        await waitForMicrotasks();

        expect(await getTurnState(ws)).toEqual({
          transcripts: ["long response"],
          abortCount: 0
        });
        expect(
          recording.messages.filter(
            (message) => message.type === "playback_interrupt"
          )
        ).toHaveLength(0);
        for (const trigger of ["flux_speech_start", "flux_eager_utterance"]) {
          expect(log).toHaveBeenCalledWith("[VoiceTrace]", {
            event: "interrupt_trigger",
            connectionId: expect.any(String),
            trigger,
            transcript,
            activePipeline: true,
            action: "below_min_words"
          });
        }
      }

      const playbackInterrupt = waitForType(ws, "playback_interrupt");
      sendJSON(ws, { type: "_emit_speech_start", text: "talk to me" });
      sendJSON(ws, { type: "_emit_eager", text: "talk to me" });
      await playbackInterrupt;

      expect(
        await waitUntilTurnState(
          ws,
          (state) => state.abortCount === 1 && state.transcripts.length === 2
        )
      ).toEqual({
        transcripts: ["long response", "talk to me"],
        abortCount: 1
      });
      expect((await waitForInterruptCount(ws, 1)).interrupt).toBe(1);
      expect(
        recording.messages.filter(
          (message) => message.type === "playback_interrupt"
        )
      ).toHaveLength(1);
    } finally {
      recording.stop();
      ws.close();
      log.mockRestore();
    }
  });
});

describe("VoiceAgent — text messages", () => {
  it("processes text messages through the pipeline", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    sendJSON(ws, { type: "text_message", text: "Hello from text" });

    const transcript = (await waitForMessageMatching(
      ws,
      (m) =>
        typeof m === "object" &&
        m !== null &&
        (m as Record<string, unknown>).type === "transcript" &&
        (m as Record<string, unknown>).role === "user"
    )) as Record<string, unknown>;

    expect(transcript.text).toBe("Hello from text");

    const transcriptEnd = (await waitForType(ws, "transcript_end")) as Record<
      string,
      unknown
    >;
    expect(transcriptEnd.text).toBe("Echo: Hello from text");

    ws.close();
  });
});

describe("VoiceAgent — client speech energy telemetry", () => {
  it("adds client RMS levels to STT turn traces without changing audio flow", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { ws } = await connectWS(uniquePath());

    try {
      await waitForStatus(ws, "idle");
      sendJSON(ws, { type: "start_call" });
      await waitForStatus(ws, "listening");

      sendJSON(ws, {
        type: "start_of_speech",
        rms: 0.07,
        threshold: 0.06
      });
      for (let i = 0; i < 3; i++) {
        ws.send(new ArrayBuffer(5000));
      }
      sendJSON(ws, {
        type: "end_of_speech",
        peak_rms: 0.21,
        threshold: 0.06
      });
      ws.send(new ArrayBuffer(5000));

      const transcript = (await waitForMessageMatching(
        ws,
        (message) =>
          typeof message === "object" &&
          message !== null &&
          (message as Record<string, unknown>).type === "transcript" &&
          (message as Record<string, unknown>).role === "user"
      )) as Record<string, unknown>;

      expect((transcript.text as string).includes("utterance 1")).toBe(true);
      expect(log).toHaveBeenCalledWith("[VoiceTrace]", {
        event: "stt_utterance",
        connectionId: expect.any(String),
        text: "utterance 1 (20000 bytes)",
        clientStartRms: 0.07,
        clientPeakRms: 0.21,
        clientThreshold: 0.06
      });
    } finally {
      ws.close();
      log.mockRestore();
    }
  });
});

describe("VoiceAgent — forceEndCall", () => {
  it("programmatically ends a call", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    sendJSON(ws, { type: "_force_end_call" });
    const msg = await waitForStatus(ws, "idle");
    expect(msg).toEqual({ type: "status", status: "idle" });

    ws.close();
  });
});

describe("VoiceAgent — edge cases", () => {
  it("audio sent before start_call is silently dropped", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");

    // Send audio before starting a call — should not crash
    ws.send(new ArrayBuffer(20000));

    // Now start a proper call — should work normally
    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    for (let i = 0; i < 4; i++) {
      ws.send(new ArrayBuffer(5000));
    }

    const transcript = (await waitForMessageMatching(
      ws,
      (m) =>
        typeof m === "object" &&
        m !== null &&
        (m as Record<string, unknown>).type === "transcript" &&
        (m as Record<string, unknown>).role === "user"
    )) as Record<string, unknown>;

    // Should only contain audio from after start_call (20000 bytes)
    expect((transcript.text as string).includes("utterance 1")).toBe(true);

    ws.close();
  });

  it("double start_call is ignored when already in a call", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    ws.send(new ArrayBuffer(10000));

    // Duplicate start_call — should be silently ignored
    sendJSON(ws, { type: "start_call" });

    // Small delay to ensure the message was processed
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Send more audio — session still alive from first start_call
    ws.send(new ArrayBuffer(10000));

    const transcript = (await waitForMessageMatching(
      ws,
      (m) =>
        typeof m === "object" &&
        m !== null &&
        (m as Record<string, unknown>).type === "transcript" &&
        (m as Record<string, unknown>).role === "user"
    )) as Record<string, unknown>;

    // Both chunks of audio (10000 + 10000 = 20000) reached the same session
    expect((transcript.text as string).includes("utterance 1")).toBe(true);
    expect((transcript.text as string).includes("20000")).toBe(true);

    ws.close();
  });
});

describe("VoiceAgent — call lifecycle counts", () => {
  it("tracks call start and end counts", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    sendJSON(ws, { type: "end_call" });
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "_get_counts" });
    const counts = (await waitForType(ws, "_counts")) as Record<
      string,
      unknown
    >;
    expect(counts.callStart).toBe(1);
    expect(counts.callEnd).toBe(1);

    ws.close();
  });
});

// --- Empty response tests (uses TestEmptyResponseVoiceAgent) ---

let emptyInstanceCounter = 0;
function uniqueEmptyPath() {
  return `/agents/test-empty-response-voice-agent/empty-test-${++emptyInstanceCounter}`;
}

async function connectEmptyWS(path: string) {
  const ctx = createExecutionContext();
  const req = new Request(`http://example.com${path}`, {
    headers: { Upgrade: "websocket" }
  });
  const res = await worker.fetch(req, env, ctx);
  expect(res.status).toBe(101);
  const ws = res.webSocket as WebSocket;
  expect(ws).toBeDefined();
  ws.accept();
  return { ws, ctx };
}

describe("VoiceAgent — empty response handling", () => {
  it("does not emit assistant transcript events for an empty stream", async () => {
    const { ws } = await connectEmptyWS(uniqueEmptyPath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, {
      type: "_set_response_mode",
      value: "empty_stream"
    });
    await waitForType(ws, "_ack");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    for (let i = 0; i < 4; i++) {
      ws.send(new ArrayBuffer(5000));
    }

    const messages = await collectMessagesUntil(
      ws,
      (msg) => msg.type === "status" && msg.status === "listening"
    );

    expect(messages).toContainEqual({
      type: "error",
      message: "No response generated"
    });
    const types = messages.map((m) => m.type);
    expect(types).not.toContain("transcript_start");
    expect(types).not.toContain("transcript_end");
    expect(types).not.toContain("metrics");

    sendJSON(ws, { type: "_get_message_count" });
    const count = (await waitForType(ws, "_message_count")) as Record<
      string,
      unknown
    >;
    expect(count.count).toBe(1);

    ws.close();
  });

  it("does not emit assistant transcript events for whitespace-only stream", async () => {
    const { ws } = await connectEmptyWS(uniqueEmptyPath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, {
      type: "_set_response_mode",
      value: "whitespace_stream"
    });
    await waitForType(ws, "_ack");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    for (let i = 0; i < 4; i++) {
      ws.send(new ArrayBuffer(5000));
    }

    const messages = await collectMessagesUntil(
      ws,
      (msg) => msg.type === "status" && msg.status === "listening"
    );

    expect(messages).toContainEqual({
      type: "error",
      message: "No response generated"
    });
    const types = messages.map((m) => m.type);
    expect(types).not.toContain("transcript_start");
    expect(types).not.toContain("transcript_end");
    expect(types).not.toContain("metrics");

    sendJSON(ws, { type: "_get_message_count" });
    const count = (await waitForType(ws, "_message_count")) as Record<
      string,
      unknown
    >;
    expect(count.count).toBe(1);

    ws.close();
  });

  it("defers assistant transcript start until streamed text is non-empty", async () => {
    const { ws } = await connectEmptyWS(uniqueEmptyPath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, {
      type: "_set_response_mode",
      value: "leading_whitespace_stream"
    });
    await waitForType(ws, "_ack");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    for (let i = 0; i < 4; i++) {
      ws.send(new ArrayBuffer(5000));
    }

    const messages = await collectMessagesUntil(
      ws,
      (msg) => msg.type === "transcript_end"
    );
    const assistantMessages = messages.filter((msg) =>
      ["transcript_start", "transcript_delta", "transcript_end"].includes(
        msg.type as string
      )
    );

    expect(assistantMessages).toEqual([
      { type: "transcript_start", role: "assistant" },
      { type: "transcript_delta", text: "   Hello" },
      { type: "transcript_delta", text: " world." },
      { type: "transcript_end", text: "   Hello world." }
    ]);

    await waitForStatus(ws, "listening");

    sendJSON(ws, { type: "_get_message_count" });
    const count = (await waitForType(ws, "_message_count")) as Record<
      string,
      unknown
    >;
    expect(count.count).toBe(2);

    ws.close();
  });

  it("sends error and does not save message when onTurn returns empty string", async () => {
    const { ws } = await connectEmptyWS(uniqueEmptyPath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    // Send enough audio to trigger utterance
    for (let i = 0; i < 4; i++) {
      ws.send(new ArrayBuffer(5000));
    }

    // Should get an error message about empty response without creating an
    // assistant transcript entry.
    const messages = await collectMessagesUntil(
      ws,
      (msg) => msg.type === "error"
    );
    expect(messages).toContainEqual({
      type: "error",
      message: "No response generated"
    });
    expect(messages.map((m) => m.type)).not.toContain("transcript_start");
    expect(messages.map((m) => m.type)).not.toContain("transcript_end");

    // Should go back to listening
    await waitForStatus(ws, "listening");

    // Should NOT have saved any assistant message
    sendJSON(ws, { type: "_get_message_count" });
    const count = (await waitForType(ws, "_message_count")) as Record<
      string,
      unknown
    >;
    // Only the user message should be saved, not an empty assistant message
    expect(count.count).toBe(1);

    ws.close();
  });

  it("does not emit metrics for empty response", async () => {
    const { ws } = await connectEmptyWS(uniqueEmptyPath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    for (let i = 0; i < 4; i++) {
      ws.send(new ArrayBuffer(5000));
    }

    // Collect all messages until we get back to listening
    const messages = await collectMessagesUntil(
      ws,
      (msg) => msg.type === "status" && msg.status === "listening"
    );

    // Should NOT have received metrics
    const types = messages.map((m) => m.type);
    expect(types).not.toContain("metrics");
    // Should have received an error
    expect(types).toContain("error");

    ws.close();
  });
});
describe("VoiceAgent — server audio transport", () => {
  it("routes ingress, TTS, flush, interrupt, and end through the transport", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "_set_audio_transport", value: true });
    await waitForAck(ws, "_set_audio_transport");
    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");
    expect(await getTransportEvents(ws)).toEqual([
      expect.stringMatching(/^start:/)
    ]);

    sendJSON(ws, { type: "_transport_ingress", byteLength: 20000 });
    await waitForAck(ws, "_transport_ingress");
    await waitForType(ws, "transcript_end");
    await waitForStatus(ws, "listening");
    expect(await getTransportEvents(ws)).toEqual([
      expect.stringMatching(/^start:/),
      expect.stringMatching(/^send:/),
      "flush"
    ]);

    const interrupted = waitForStatus(ws, "listening");
    sendJSON(ws, { type: "interrupt" });
    await interrupted;
    expect(await getTransportEvents(ws)).toContain("interrupt");

    const ended = waitForStatus(ws, "idle");
    sendJSON(ws, { type: "end_call" });
    await ended;
    expect(await getTransportEvents(ws)).toContain("stop");
  });
  it("marks sentence playback only after its audio and drops aborted text", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");
    sendJSON(ws, { type: "_set_audio_transport", value: "marked" });
    await waitForAck(ws, "_set_audio_transport");
    await setTtsMode(ws, "marked");
    await startCall(ws);

    sendJSON(ws, { type: "text_message", text: "marker pipeline" });
    await waitForTransportSendCount(ws, 1);
    const firstStateResponse = waitForType(ws, "_marker_tts_state");
    sendJSON(ws, { type: "_get_marker_tts_state" });
    const firstState = (await firstStateResponse) as {
      synthesizeStreamTexts: string[];
      synthesizeTextStreamCalls: number;
    };
    expect(firstState).toMatchObject({
      synthesizeStreamTexts: ["First sentence."],
      synthesizeTextStreamCalls: 0
    });

    sendJSON(ws, { type: "_release_model_stream" });
    await waitForAck(ws, "_release_model_stream");
    await waitForMicrotasks();
    const serializedStateResponse = waitForType(ws, "_marker_tts_state");
    sendJSON(ws, { type: "_get_marker_tts_state" });
    await expect(serializedStateResponse).resolves.toMatchObject({
      synthesizeStreamTexts: ["First sentence."],
      synthesizeTextStreamCalls: 0
    });

    sendJSON(ws, { type: "_release_tts" });
    await waitForAck(ws, "_release_tts");
    let events = await waitForTransportEventCount(
      ws,
      "mark:First sentence.",
      1
    );
    const firstMark = events.indexOf("mark:First sentence.");
    expect(events.slice(0, firstMark)).toEqual([
      expect.stringMatching(/^start:/),
      "reset-text",
      expect.stringMatching(/^send:/),
      expect.stringMatching(/^send:/)
    ]);

    await waitForTransportSendCount(ws, 3);
    sendJSON(ws, { type: "interrupt" });
    events = await waitForTransportEventCount(ws, "interrupt", 1);
    await waitForMicrotasks();
    expect(events.filter((event) => event.startsWith("mark:"))).toEqual([
      "mark:First sentence."
    ]);

    const finalStateResponse = waitForType(ws, "_marker_tts_state");
    sendJSON(ws, { type: "_get_marker_tts_state" });
    const finalState = (await finalStateResponse) as {
      synthesizeStreamTexts: string[];
      synthesizeTextStreamCalls: number;
    };
    expect(finalState).toMatchObject({
      synthesizeStreamTexts: ["First sentence.", "Second sentence."],
      synthesizeTextStreamCalls: 0
    });
    ws.close();
  });

  it("orders opted-in playback markers after binary sentence audio", async () => {
    const { ws } = await connectWS(uniquePath());
    await waitForStatus(ws, "idle");
    await setTtsMode(ws, "sentence");
    sendJSON(ws, { type: "start_call", playback_markers: true });
    await waitForStatus(ws, "listening");
    const recording = recordSocket(ws);
    sendJSON(ws, { type: "text_message", text: "marker pipeline" });
    await vi.waitFor(() => expect(recording.binaryCount).toBeGreaterThan(0));
    const firstMarkerPromise = waitForMessageMatching(
      ws,
      (message) =>
        typeof message === "object" &&
        message !== null &&
        (message as Record<string, unknown>).type === "playback_marker" &&
        (message as Record<string, unknown>).sequence === 1
    );
    sendJSON(ws, { type: "_release_tts" });
    await waitForAck(ws, "_release_tts");
    const firstMarker = (await firstMarkerPromise) as Record<string, unknown>;
    sendJSON(ws, { type: "_release_model_stream" });
    await waitForAck(ws, "_release_model_stream");
    const secondMarkerPromise = waitForMessageMatching(
      ws,
      (message) =>
        typeof message === "object" &&
        message !== null &&
        (message as Record<string, unknown>).type === "playback_marker" &&
        (message as Record<string, unknown>).sequence === 2
    );
    sendJSON(ws, { type: "_release_tts" });
    await waitForAck(ws, "_release_tts");
    const secondMarker = (await secondMarkerPromise) as Record<string, unknown>;

    const markers = recording.events.filter(
      (event): event is Record<string, unknown> =>
        event !== "binary" && event.type === "playback_marker"
    );
    expect(markers).toHaveLength(2);
    expect(firstMarker.playbackId).toBe(secondMarker.playbackId);
    expect(firstMarker.playbackId).toEqual(expect.any(String));
    expect((firstMarker.playbackId as string).length).toBeGreaterThan(0);
    expect(firstMarker.sequence).toBe(1);
    expect(secondMarker.sequence).toBe(2);
    const firstMarkerIndex = recording.events.findIndex(
      (event) =>
        event !== "binary" &&
        event.type === "playback_marker" &&
        event.sequence === 1
    );
    const secondMarkerIndex = recording.events.findIndex(
      (event) =>
        event !== "binary" &&
        event.type === "playback_marker" &&
        event.sequence === 2
    );
    expect(
      recording.events
        .slice(0, firstMarkerIndex)
        .filter((event) => event === "binary")
    ).not.toHaveLength(0);
    expect(
      recording.events
        .slice(firstMarkerIndex + 1, secondMarkerIndex)
        .filter((event) => event === "binary")
    ).not.toHaveLength(0);

    await waitForStatus(ws, "listening");
    const binaryCountBeforeInterrupt = recording.binaryCount;
    sendJSON(ws, { type: "text_message", text: "marker pipeline" });
    await vi.waitFor(() =>
      expect(recording.binaryCount).toBeGreaterThan(binaryCountBeforeInterrupt)
    );
    sendJSON(ws, { type: "_release_model_stream" });
    await waitForAck(ws, "_release_model_stream");
    await vi.waitFor(() =>
      expect(recording.binaryCount).toBeGreaterThan(binaryCountBeforeInterrupt)
    );
    const interrupted = waitForStatus(ws, "listening");
    sendJSON(ws, { type: "interrupt" });
    await interrupted;
    await waitForMicrotasks();
    expect(
      recording.messages.filter(
        (message) =>
          message.type === "playback_marker" &&
          message.playbackId !== firstMarker.playbackId &&
          message.sequence === 2
      )
    ).toEqual([]);
    recording.stop();
    ws.close();
  });

  it("stops the transport on abrupt connection close", async () => {
    const instanceName = `voice-test-${crypto.randomUUID()}`;
    const stub = env.TestVoiceAgent.get(
      env.TestVoiceAgent.idFromName(instanceName)
    ) as DurableObjectStub<TestVoiceAgent>;

    const events = await runInDurableObject(stub, (instance) =>
      instance.exerciseAbruptTransportCloseForTest()
    );
    expect(events).toContain("stop");
  });

  it("keeps binary WebSocket playback without a server transport", async () => {
    const instanceName = `voice-test-${crypto.randomUUID()}`;
    const stub = env.TestVoiceAgent.get(
      env.TestVoiceAgent.idFromName(instanceName)
    ) as DurableObjectStub<TestVoiceAgent>;

    await expect(
      runInDurableObject(stub, (instance) =>
        instance.exerciseWebSocketPlaybackForTest()
      )
    ).resolves.toBe(true);
  });
});

describe("VoiceAgent — bidirectional streaming TTS", () => {
  async function collectBinaryUntilMetrics(
    ws: WebSocket,
    timeout = 5000
  ): Promise<string[]> {
    return new Promise<string[]>((resolve, reject) => {
      const frames: string[] = [];
      // ponytail: real-wait integration test — resolves on the `metrics` WS
      // event; the timer is only a hang backstop (matches every helper here).
      const timer = setTimeout(() => {
        ws.removeEventListener("message", handler);
        reject(new Error("Timeout collecting binary TTS frames"));
      }, timeout);
      const handler = (e: MessageEvent) => {
        if (typeof e.data === "string") {
          try {
            const msg = JSON.parse(e.data) as Record<string, unknown>;
            if (msg.type === "metrics") {
              clearTimeout(timer);
              ws.removeEventListener("message", handler);
              resolve(frames);
            }
          } catch {
            // ignore non-JSON text control messages
          }
          return;
        }
        void toArrayBuffer(e.data).then((buffer) => {
          if (buffer) frames.push(decodeAudio(buffer));
        });
      };
      ws.addEventListener("message", handler);
    });
  }

  it("feeds model text deltas directly to a streaming-text TTS provider", async () => {
    const { ws } = await connectWS(uniqueStreamingTTSPath());
    await waitForStatus(ws, "idle");

    sendJSON(ws, { type: "start_call" });
    await waitForStatus(ws, "listening");

    const allFrames = collectBinaryUntilMetrics(ws);

    // 20000 bytes triggers one utterance in the deterministic transcriber.
    for (let i = 0; i < 4; i++) {
      ws.send(new ArrayBuffer(5000));
    }

    // Confirm the streaming branch ran — metrics is emitted after the pipeline.
    const frames = await allFrames;

    // Query the provider for the chunks it actually streamed.
    const chunksResponse = waitForType(ws, "_streaming_tts_chunks");
    sendJSON(ws, { type: "_get_streaming_tts_chunks" });
    const chunks = (await chunksResponse) as {
      chunks: string[];
    };

    // The model yields exactly two text deltas. The provider receives and
    // speaks both directly rather than waiting for a sentence boundary.
    expect(chunks.chunks).toHaveLength(2);
    expect(frames.length).toBe(2);

    // Both streamed audio chunks reconstruct the model response.
    const echoed = frames.join("");
    expect(echoed).toEqual(expect.stringContaining("Echo:"));

    ws.close();
  });
});

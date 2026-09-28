import { afterEach, expect, it, vi } from "vitest";
import { ElevenLabsSTT, ElevenLabsTTS } from "../src/index";

class MockWebSocket extends EventTarget {
  accept = vi.fn();
  send = vi.fn();
  close = vi.fn();
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function connectWith(ws = new MockWebSocket()) {
  const fetchMock = vi.fn(
    async () => ({ webSocket: ws }) as unknown as Response
  );
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, ws };
}

function sentJSON(ws: MockWebSocket): Array<Record<string, unknown>> {
  return ws.send.mock.calls.map(([message]) => JSON.parse(String(message)));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

it.each([
  [undefined, "mp3", undefined],
  ["pcm_16000", "pcm16", 16000],
  ["ulaw_8000", "mulaw", 8000],
  ["custom", undefined, undefined]
] as const)(
  "declares the %s TTS output format",
  (outputFormat, audioFormat, sampleRate) => {
    const provider = new ElevenLabsTTS({ apiKey: "test-key", outputFormat });

    expect(provider.audioFormat).toBe(audioFormat);
    expect(provider.sampleRate).toBe(sampleRate);
  }
);

it("streams Eleven v4 dialogue over one WebSocket", async () => {
  const { fetchMock, ws } = connectWith();
  const provider = new ElevenLabsTTS({
    apiKey: "test-key",
    voiceId: "voice-1",
    modelId: "eleven_v4_turbo",
    outputFormat: "ulaw_8000"
  });
  const stream = provider.synthesizeTextStream?.(
    new ReadableStream<string>({
      start(controller) {
        controller.enqueue("[reassuring] I found ");
        controller.enqueue("the duplicate charge.");
        controller.close();
      }
    })
  );
  expect(stream).toBeDefined();

  const firstChunk = stream!.next();
  await flush();

  expect(fetchMock).toHaveBeenCalledWith(
    expect.objectContaining({
      pathname: "/v1/text-to-dialogue/stream-input",
      search: "?model_id=eleven_v4_turbo&output_format=ulaw_8000"
    }),
    {
      headers: {
        Upgrade: "websocket",
        "xi-api-key": "test-key"
      },
      signal: undefined
    }
  );
  expect(sentJSON(ws)).toEqual([
    { voices: ["voice-1"] },
    {
      inputs: [
        {
          text: "[reassuring] I found ",
          voice_id: "voice-1",
          new_turn: false
        }
      ]
    },
    {
      inputs: [
        {
          text: "the duplicate charge.",
          voice_id: "voice-1",
          new_turn: false
        }
      ]
    },
    { close_socket: true }
  ]);

  ws.dispatchEvent(
    new MessageEvent("message", {
      data: JSON.stringify({ audio: btoa("\x01\x02\xff") })
    })
  );
  await expect(firstChunk).resolves.toEqual({
    done: false,
    value: new Uint8Array([1, 2, 255]).buffer
  });

  const completion = stream!.next();
  ws.dispatchEvent(
    new MessageEvent("message", {
      data: JSON.stringify({ is_final: true })
    })
  );
  await expect(completion).resolves.toEqual({
    done: true,
    value: undefined
  });
  expect(ws.close).toHaveBeenCalled();
});

it("uses dialogue streaming for complete Eleven v4 text", async () => {
  const { ws } = connectWith();
  const provider = new ElevenLabsTTS({
    apiKey: "test-key",
    voiceId: "voice-1",
    modelId: "eleven_v4"
  });
  const stream = provider.synthesizeStream("One complete line.");

  const firstChunk = stream.next();
  await flush();
  expect(sentJSON(ws)).toEqual([
    { voices: ["voice-1"] },
    {
      inputs: [
        {
          text: "One complete line.",
          voice_id: "voice-1",
          new_turn: false
        }
      ]
    },
    { close_socket: true }
  ]);

  ws.dispatchEvent(
    new MessageEvent("message", {
      data: JSON.stringify({ audio: btoa("audio"), is_final: true })
    })
  );
  await expect(firstChunk).resolves.toEqual({
    done: false,
    value: new TextEncoder().encode("audio").buffer
  });
  await expect(stream.next()).resolves.toEqual({
    done: true,
    value: undefined
  });
});

it("closes Eleven v4 dialogue generation when aborted", async () => {
  const { ws } = connectWith();
  const provider = new ElevenLabsTTS({
    apiKey: "test-key",
    modelId: "eleven_v4_turbo"
  });
  const abort = new AbortController();
  const stream = provider.synthesizeStream("Stop speaking.", abort.signal);
  const pending = stream.next();
  await flush();

  abort.abort();

  await expect(pending).resolves.toEqual({ done: true, value: undefined });
  expect(ws.close).toHaveBeenCalled();
});

it("rejects readiness when closed while the connection is pending", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise<Response>(() => {}))
  );

  const fatalErrors: unknown[] = [];
  const session = new ElevenLabsSTT({ apiKey: "test-key" }).createSession({
    onFatalError: (error) => fatalErrors.push(error)
  });
  const readiness = expect(session.waitUntilReady?.()).rejects.toThrow(
    "ElevenLabsSTT: WebSocket closed before session start."
  );

  session.close();

  await readiness;
  expect(fatalErrors).toEqual([]);
});

it("handles connection rejection before readiness is awaited", async () => {
  const { ws } = connectWith();
  const fatalErrors: unknown[] = [];
  const session = new ElevenLabsSTT({ apiKey: "test-key" }).createSession({
    onFatalError: (error) => fatalErrors.push(error)
  });
  await flush();

  ws.dispatchEvent(new Event("error"));
  await flush();

  await expect(session.waitUntilReady?.()).rejects.toThrow(
    "ElevenLabsSTT: WebSocket error."
  );
  expect(fatalErrors).toHaveLength(1);
  expect((fatalErrors[0] as Error).message).toBe(
    "ElevenLabsSTT: WebSocket error."
  );
});

it("reports one fatal error when a ready socket errors and then closes", async () => {
  const { ws } = connectWith();
  const fatalErrors: unknown[] = [];
  const session = new ElevenLabsSTT({ apiKey: "test-key" }).createSession({
    onFatalError: (error) => fatalErrors.push(error)
  });
  await flush();
  ws.dispatchEvent(
    new MessageEvent("message", {
      data: JSON.stringify({ message_type: "session_started" })
    })
  );
  await session.waitUntilReady?.();

  ws.dispatchEvent(new Event("error"));
  ws.dispatchEvent(new Event("close"));

  expect(fatalErrors).toHaveLength(1);
  expect((fatalErrors[0] as Error).message).toBe(
    "ElevenLabsSTT: WebSocket error."
  );
});

it("wraps a non-Error connection failure without logging its payload", async () => {
  const providerError = {
    code: 429,
    error: { message: "quota exceeded", apiKey: "must-not-leak" }
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Promise.reject(providerError))
  );
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

  const session = new ElevenLabsSTT({ apiKey: "test-key" }).createSession();

  await expect(session.waitUntilReady?.()).rejects.toThrow(
    "ElevenLabs STT connection failed"
  );
  expect(errorSpy).toHaveBeenCalledWith({
    component: "ElevenLabsSTT",
    stage: "connection",
    message: "ElevenLabs STT connection failed",
    error: expect.objectContaining({
      name: "Error",
      message: "ElevenLabs STT connection failed"
    })
  });
  expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("quota exceeded");
  expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("must-not-leak");
  errorSpy.mockRestore();
});

it("converts a local ws base URL for the fetch upgrade", async () => {
  const { fetchMock, ws } = connectWith();
  const session = new ElevenLabsSTT({
    apiKey: "test-key",
    baseUrl: "ws://localhost:8787/realtime"
  }).createSession();
  await flush();

  expect(fetchMock).toHaveBeenCalledWith(
    expect.stringMatching(/^http:\/\/localhost:8787\/realtime\?/),
    expect.any(Object)
  );

  ws.dispatchEvent(
    new MessageEvent("message", {
      data: JSON.stringify({ message_type: "session_started" })
    })
  );
  session.close();
});

it("caps audio buffered while the connection is pending", async () => {
  const ws = new MockWebSocket();
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  let resolveFetch!: (response: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        })
    )
  );

  const session = new ElevenLabsSTT({ apiKey: "test-key" }).createSession();
  await flush();
  errorSpy.mockClear();
  for (let i = 0; i < 31; i++) {
    session.feed(new ArrayBuffer(32_000));
  }

  resolveFetch({ webSocket: ws } as unknown as Response);
  await flush();

  expect(ws.send).toHaveBeenCalledTimes(30);
  expect(errorSpy).toHaveBeenCalledTimes(1);
  expect(errorSpy).toHaveBeenCalledWith(
    expect.objectContaining({
      component: "ElevenLabsSTT",
      stage: "audio_buffer",
      error: expect.objectContaining({
        message: "Dropping audio until the socket connects"
      })
    })
  );
  errorSpy.mockRestore();

  ws.dispatchEvent(
    new MessageEvent("message", {
      data: JSON.stringify({ message_type: "session_started" })
    })
  );
  session.close();
});

it("signals speech start once per committed segment", async () => {
  const { ws } = connectWith();
  const onSpeechStart = vi.fn();
  const session = new ElevenLabsSTT({ apiKey: "test-key" }).createSession({
    onSpeechStart
  });
  await flush();

  const message = (message_type: string, text: string) =>
    ws.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({ message_type, text })
      })
    );

  message("partial_transcript", "hello");
  message("partial_transcript", "hello there");
  message("committed_transcript", "hello there");
  message("partial_transcript", "next");

  expect(onSpeechStart).toHaveBeenCalledTimes(2);
  expect(onSpeechStart).toHaveBeenNthCalledWith(1, "hello");
  expect(onSpeechStart).toHaveBeenNthCalledWith(2, "next");

  ws.dispatchEvent(
    new MessageEvent("message", {
      data: JSON.stringify({ message_type: "session_started" })
    })
  );
  session.close();
});

it("contains audio send failures while the socket is closing", async () => {
  const { ws } = connectWith();
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const session = new ElevenLabsSTT({ apiKey: "test-key" }).createSession();
  await flush();
  ws.send.mockImplementation(() => {
    throw new Error("socket is closing");
  });

  expect(() => session.feed(new ArrayBuffer(3_200))).not.toThrow();
  expect(errorSpy).toHaveBeenCalledWith(
    expect.objectContaining({
      component: "ElevenLabsSTT",
      stage: "websocket_send",
      error: expect.objectContaining({ message: "socket is closing" })
    })
  );

  errorSpy.mockRestore();
  session.close();
});

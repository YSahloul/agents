import { describe, expect, it, vi } from "vitest";
import {
  WorkersAIFluxSTT,
  WorkersAIMulawRealtimeTTS,
  WorkersAINova3STT,
  WorkersAITTS
} from "../workers-ai-providers";

class MockWebSocket {
  accepted = false;
  closed = false;
  readyState = 1;
  sent: unknown[] = [];
  #listeners = new Map<string, Set<(event: { data?: unknown }) => void>>();

  accept(): void {
    this.accepted = true;
  }

  close(): void {
    this.closed = true;
    this.dispatch("close", {});
  }

  send(chunk: unknown): void {
    this.sent.push(chunk);
  }

  addEventListener(
    type: string,
    listener: (event: { data?: unknown }) => void
  ) {
    const listeners = this.#listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }

  dispatch(type: string, event: { data?: unknown }): void {
    for (const listener of this.#listeners.get(type) ?? []) {
      listener(event);
    }
  }

  message(data: unknown): void {
    this.dispatch("message", { data });
  }
}

class MockAi {
  mode: "socket" | "throw" | "no_socket" = "socket";
  deferRun = false;
  sockets: MockWebSocket[] = [];
  calls: Array<{
    model: string;
    input: Record<string, unknown>;
    options?: Record<string, unknown>;
  }> = [];
  #resolveRun: (() => void) | null = null;

  resolveRun(): void {
    const resolve = this.#resolveRun;
    if (!resolve) return;
    this.#resolveRun = null;
    resolve();
  }

  async run(
    model: string,
    input: Record<string, unknown>,
    options?: Record<string, unknown>
  ): Promise<unknown> {
    this.calls.push({ model, input, options });
    if (this.deferRun) {
      await new Promise<void>((resolve) => {
        this.#resolveRun = resolve;
      });
    }
    if (this.mode === "throw") throw new Error("run failed");
    if (this.mode === "no_socket") return {};
    const webSocket = new MockWebSocket();
    this.sockets.push(webSocket);
    return { webSocket };
  }
}

async function waitForConnect(ai: MockAi): Promise<MockWebSocket> {
  await Promise.resolve();
  await Promise.resolve();
  const socket = ai.sockets.at(-1);
  if (!socket) throw new Error("expected a mock websocket to be created");
  return socket;
}

describe("WorkersAIMulawRealtimeTTS", () => {
  it("does not connect until the stream is iterated", async () => {
    const ai = new MockAi();
    const tts = new WorkersAIMulawRealtimeTTS(ai);
    tts.synthesizeStream("hello");
    await Promise.resolve();
    expect(ai.calls).toHaveLength(0);
  });

  it("requests mulaw/8000 and yields 20 ms frames, ending on Flushed", async () => {
    const ai = new MockAi();
    const tts = new WorkersAIMulawRealtimeTTS(ai, { speaker: "luna" });
    expect(tts.audioFormat).toBe("mulaw");
    expect(tts.sampleRate).toBe(8000);

    const frames: number[][] = [];
    const done = (async () => {
      for await (const frame of tts.synthesizeStream("hello")) {
        frames.push([...new Uint8Array(frame)]);
      }
    })();

    const socket = await waitForConnect(ai);
    expect(ai.calls[0].input).toMatchObject({
      encoding: "mulaw",
      sample_rate: "8000",
      speaker: "luna",
      container: "none"
    });
    expect(ai.calls[0].options).toMatchObject({ websocket: true });
    expect(socket.sent).toContain(
      JSON.stringify({ type: "Speak", text: "hello", speaker: "luna" })
    );
    expect(socket.sent).toContain(JSON.stringify({ type: "Flush" }));

    // Transport fragments are coalesced into 160-byte frames.
    socket.message(new Uint8Array(100).fill(1).buffer);
    socket.message(new Uint8Array(100).fill(2).buffer);
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    expect(frames[0]).toHaveLength(160);

    // Flushed emits the partial remainder and ends the stream.
    socket.message(JSON.stringify({ type: "Flushed" }));
    await done;
    expect(frames).toHaveLength(2);
    expect(frames[1]).toHaveLength(40);
    expect(socket.closed).toBe(true);
  });

  it("throws instead of hanging when the socket dies before Flushed", async () => {
    const ai = new MockAi();
    const tts = new WorkersAIMulawRealtimeTTS(ai);

    const consumed = (async () => {
      for await (const _frame of tts.synthesizeStream("interrupted")) {
        // drain
      }
    })();

    const socket = await waitForConnect(ai);
    socket.message(new Uint8Array(160).fill(3).buffer);
    socket.close();

    await expect(consumed).rejects.toThrow(/closed before flush/);
  });

  it("surfaces a socket error rather than stalling the turn", async () => {
    const ai = new MockAi();
    const tts = new WorkersAIMulawRealtimeTTS(ai);

    const consumed = (async () => {
      for await (const _frame of tts.synthesizeStream("boom")) {
        // drain
      }
    })();

    const socket = await waitForConnect(ai);
    socket.dispatch("error", {});

    await expect(consumed).rejects.toThrow(/socket error/);
  });

  it("closes the socket when the consumer abandons the stream", async () => {
    const ai = new MockAi();
    const tts = new WorkersAIMulawRealtimeTTS(ai);
    const stream = tts.synthesizeStream("partial");

    const first = stream.next();
    const socket = await waitForConnect(ai);
    socket.message(new Uint8Array(160).fill(9).buffer);
    await first;

    await stream.return(undefined);
    expect(socket.closed).toBe(true);
  });

  it("yields nothing for empty text or an already-aborted signal", async () => {
    const ai = new MockAi();
    const tts = new WorkersAIMulawRealtimeTTS(ai);

    for await (const _frame of tts.synthesizeStream("")) {
      throw new Error("expected no frames");
    }
    for await (const _frame of tts.synthesizeStream(
      "hi",
      AbortSignal.abort()
    )) {
      throw new Error("expected no frames");
    }
    expect(ai.calls).toHaveLength(0);
  });

  it("falls back to synthesize() (inherited HTTP path) with matching mulaw config", async () => {
    const ai = new MockAi();
    ai.mode = "no_socket";
    const run = vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer
    }));
    const tts = new WorkersAIMulawRealtimeTTS({
      run
    } as unknown as ConstructorParameters<typeof WorkersAITTS>[0]);
    await tts.synthesize("hi");
    expect(run).toHaveBeenCalledWith(
      "@cf/deepgram/aura-2-en",
      expect.objectContaining({
        encoding: "mulaw",
        sample_rate: 8000,
        container: "none"
      }),
      expect.objectContaining({ returnRawResponse: true })
    );
  });
});

describe("WorkersAIFluxSTT", () => {
  it("resolves readiness after the WebSocket is accepted and pending audio is flushed", async () => {
    const ai = new MockAi();
    const session = new WorkersAIFluxSTT(ai).createSession();
    const chunk = new ArrayBuffer(4);

    session.feed(chunk);
    if (!session.waitUntilReady) throw new Error("expected readiness method");
    await session.waitUntilReady();

    const socket = ai.sockets[0];
    expect(socket.accepted).toBe(true);
    expect(socket.sent).toEqual([chunk]);
  });

  it("rejects readiness when ai.run throws", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const ai = new MockAi();
    ai.mode = "throw";
    try {
      const session = new WorkersAIFluxSTT(ai).createSession();
      if (!session.waitUntilReady) throw new Error("expected readiness method");

      await expect(session.waitUntilReady()).rejects.toThrow("run failed");
    } finally {
      errorLog.mockRestore();
    }
  });

  it("rejects readiness when ai.run returns no WebSocket", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const ai = new MockAi();
    ai.mode = "no_socket";
    try {
      const session = new WorkersAIFluxSTT(ai).createSession();
      if (!session.waitUntilReady) throw new Error("expected readiness method");

      await expect(session.waitUntilReady()).rejects.toThrow(
        "Workers AI Flux STT did not return a WebSocket"
      );
    } finally {
      errorLog.mockRestore();
    }
  });

  it("settles readiness when closed before the WebSocket connects", async () => {
    const ai = new MockAi();
    ai.deferRun = true;
    const session = new WorkersAIFluxSTT(ai).createSession();
    if (!session.waitUntilReady) throw new Error("expected readiness method");

    const ready = session.waitUntilReady();
    await Promise.resolve();
    session.close();

    await expect(ready).resolves.toBeUndefined();
    ai.resolveRun();

    const socket = await waitForConnect(ai);
    expect(socket.accepted).toBe(true);
    expect(socket.closed).toBe(true);
  });

  it("uses the latest interim transcript when EndOfTurn transcript is empty", async () => {
    const ai = new MockAi();
    const utterances: string[] = [];
    const interims: string[] = [];

    new WorkersAIFluxSTT(ai).createSession({
      onInterim: (text) => interims.push(text),
      onUtterance: (text) => utterances.push(text)
    });

    const socket = await waitForConnect(ai);
    socket.message(JSON.stringify({ event: "StartOfTurn" }));
    socket.message(JSON.stringify({ event: "Update", transcript: "hello" }));
    socket.message(
      JSON.stringify({ event: "Update", transcript: "hello world" })
    );
    socket.message(JSON.stringify({ event: "EndOfTurn", transcript: "" }));

    expect(interims).toEqual(["hello", "hello world"]);
    expect(utterances).toEqual(["hello world"]);
  });
  it("uses StartOfTurn transcript when EndOfTurn transcript is empty", async () => {
    const ai = new MockAi();
    const utterances: string[] = [];
    const interims: string[] = [];
    const speechStarts: Array<string | undefined> = [];

    new WorkersAIFluxSTT(ai).createSession({
      onInterim: (text) => interims.push(text),
      onSpeechStart: (text) => speechStarts.push(text),
      onUtterance: (text) => utterances.push(text)
    });

    const socket = await waitForConnect(ai);
    socket.message(
      JSON.stringify({ event: "StartOfTurn", transcript: "hello" })
    );
    socket.message(JSON.stringify({ event: "EndOfTurn", transcript: "" }));

    expect(interims).toEqual(["hello"]);
    expect(speechStarts).toEqual(["hello"]);
    expect(utterances).toEqual(["hello"]);
  });

  it("emits speech start without requiring a transcript", async () => {
    const ai = new MockAi();
    const speechStarts: Array<string | undefined> = [];

    new WorkersAIFluxSTT(ai).createSession({
      onSpeechStart: (text) => speechStarts.push(text)
    });

    const socket = await waitForConnect(ai);
    socket.message(JSON.stringify({ event: "StartOfTurn" }));

    expect(speechStarts).toEqual([undefined]);
  });

  it("prefers non-empty EndOfTurn transcript and clears turn state", async () => {
    const ai = new MockAi();
    const utterances: string[] = [];

    new WorkersAIFluxSTT(ai).createSession({
      onUtterance: (text) => utterances.push(text)
    });

    const socket = await waitForConnect(ai);
    socket.message(JSON.stringify({ event: "Update", transcript: "stale" }));
    socket.message(
      JSON.stringify({ event: "EndOfTurn", transcript: "final text" })
    );
    socket.message(JSON.stringify({ event: "EndOfTurn", transcript: "" }));

    expect(utterances).toEqual(["final text"]);
  });

  it("preserves accumulated transcript when TurnResumed arrives empty", async () => {
    const ai = new MockAi();
    const utterances: string[] = [];
    const interims: string[] = [];

    new WorkersAIFluxSTT(ai).createSession({
      onInterim: (text) => interims.push(text),
      onUtterance: (text) => utterances.push(text)
    });

    const socket = await waitForConnect(ai);
    socket.message(JSON.stringify({ event: "StartOfTurn" }));
    socket.message(
      JSON.stringify({ event: "Update", transcript: "who is there" })
    );
    // Eager end-of-turn, then the model hears the user still talking and
    // resumes with an empty transcript — must NOT wipe the accumulation.
    socket.message(
      JSON.stringify({ event: "EagerEndOfTurn", transcript: "who is there" })
    );
    socket.message(JSON.stringify({ event: "TurnResumed", transcript: "" }));
    socket.message(
      JSON.stringify({ event: "Update", transcript: "who is there or two" })
    );
    socket.message(JSON.stringify({ event: "EndOfTurn", transcript: "" }));

    expect(utterances).toEqual(["who is there or two"]);
  });

  it("fires onSpeechStart once (StartOfTurn) and TurnResumed does not re-signal", async () => {
    const ai = new MockAi();
    const speechStarts: Array<string | undefined> = [];

    new WorkersAIFluxSTT(ai).createSession({
      onSpeechStart: (text) => speechStarts.push(text)
    });

    const socket = await waitForConnect(ai);
    socket.message(JSON.stringify({ event: "StartOfTurn" }));
    socket.message(
      JSON.stringify({ event: "EagerEndOfTurn", transcript: "hello" })
    );
    socket.message(
      JSON.stringify({ event: "TurnResumed", transcript: "hello" })
    );
    socket.message(JSON.stringify({ event: "EndOfTurn", transcript: "" }));

    // Upstream: TurnResumed does NOT fire onSpeechStart — only StartOfTurn does
    expect(speechStarts).toEqual([undefined]);
  });

  it("forwards the full keyterms array to ai.run", async () => {
    const ai = new MockAi();
    const keyterms = ["BrokerBot", "SkySlope", "MLS", "CMA", "BPO"];

    new WorkersAIFluxSTT(ai, { keyterms }).createSession();
    await waitForConnect(ai);

    expect(ai.calls).toHaveLength(1);
    expect(ai.calls[0]?.model).toBe("@cf/deepgram/flux");
    expect(ai.calls[0]?.input.keyterm).toEqual(keyterms);
  });
});

describe("WorkersAINova3STT", () => {
  it("waits for transcript evidence before emitting speech start", async () => {
    const ai = new MockAi();
    const speechStarts: Array<string | undefined> = [];

    new WorkersAINova3STT(ai).createSession({
      onSpeechStart: (text) => speechStarts.push(text)
    });

    const socket = await waitForConnect(ai);
    socket.message(JSON.stringify({ type: "SpeechStarted" }));
    expect(speechStarts).toEqual([]);

    socket.message(
      JSON.stringify({
        type: "Results",
        is_final: false,
        speech_final: false,
        channel: { alternatives: [{ transcript: "hello" }] }
      })
    );
    socket.message(
      JSON.stringify({
        type: "Results",
        is_final: false,
        speech_final: false,
        channel: { alternatives: [{ transcript: "hello there" }] }
      })
    );

    expect(speechStarts).toEqual(["hello"]);
  });

  it("combines finalized segments and interim text without changing normal behavior", async () => {
    const ai = new MockAi();
    const utterances: string[] = [];
    const interims: string[] = [];

    new WorkersAINova3STT(ai).createSession({
      onInterim: (text) => interims.push(text),
      onUtterance: (text) => utterances.push(text)
    });

    const socket = await waitForConnect(ai);
    socket.message(
      JSON.stringify({
        type: "Results",
        is_final: true,
        speech_final: false,
        channel: { alternatives: [{ transcript: "hello" }] }
      })
    );
    socket.message(
      JSON.stringify({
        type: "Results",
        is_final: false,
        speech_final: false,
        channel: { alternatives: [{ transcript: "world" }] }
      })
    );
    socket.message(
      JSON.stringify({
        type: "Results",
        is_final: true,
        speech_final: true,
        channel: { alternatives: [{ transcript: "world" }] }
      })
    );

    expect(interims).toEqual(["hello world"]);
    expect(utterances).toEqual(["hello world"]);
  });

  it("ignores malformed messages and empty speech_final results", async () => {
    const ai = new MockAi();
    const utterances: string[] = [];

    new WorkersAINova3STT(ai).createSession({
      onUtterance: (text) => utterances.push(text)
    });

    const socket = await waitForConnect(ai);
    socket.message("not json");
    socket.message(
      JSON.stringify({
        type: "Results",
        is_final: false,
        speech_final: true,
        channel: { alternatives: [{ transcript: "" }] }
      })
    );

    expect(utterances).toEqual([]);
  });

  it("handles late Results messages after websocket close", async () => {
    const ai = new MockAi();
    const utterances: string[] = [];

    new WorkersAINova3STT(ai).createSession({
      onUtterance: (text) => utterances.push(text)
    });

    const socket = await waitForConnect(ai);
    socket.message(
      JSON.stringify({
        type: "Results",
        is_final: true,
        speech_final: false,
        channel: { alternatives: [{ transcript: "late" }] }
      })
    );
    socket.close();
    socket.message(
      JSON.stringify({
        type: "Results",
        is_final: true,
        speech_final: true,
        channel: { alternatives: [{ transcript: "message" }] }
      })
    );

    expect(utterances).toEqual(["late message"]);
  });

  it("forwards the full keyterms array to ai.run", async () => {
    const ai = new MockAi();
    const keyterms = ["BrokerBot", "SkySlope", "MLS", "CMA", "BPO"];

    new WorkersAINova3STT(ai, { keyterms }).createSession();
    await waitForConnect(ai);

    expect(ai.calls).toHaveLength(1);
    expect(ai.calls[0]?.model).toBe("@cf/deepgram/nova-3");
    expect(ai.calls[0]?.input.keyterm).toEqual(keyterms);
  });
});

// --- WorkersAITTS ---

describe("WorkersAITTS", () => {
  it("keeps the default request unchanged and returns its audio bytes", async () => {
    const audio = new Uint8Array([1, 2, 3, 4]).buffer;
    const run = vi.fn(async () => new Response(audio, { status: 200 }));
    const tts = new WorkersAITTS({ run });
    const result = await tts.synthesize("hello");

    expect(run).toHaveBeenCalledWith(
      "@cf/deepgram/aura-1",
      { text: "hello", speaker: "asteria" },
      { returnRawResponse: true }
    );
    expect(result).not.toBeNull();
    expect(new Uint8Array(result!)).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it("forwards explicitly configured output fields with a numeric sample rate", async () => {
    const run = vi.fn(async () => new Response(new ArrayBuffer(0)));
    const tts = new WorkersAITTS(
      { run },
      { encoding: "linear16", container: "none", sampleRate: 24000 }
    );

    await tts.synthesize("hello");
    expect(run).toHaveBeenCalledWith(
      "@cf/deepgram/aura-1",
      {
        text: "hello",
        speaker: "asteria",
        encoding: "linear16",
        container: "none",
        sample_rate: 24000
      },
      { returnRawResponse: true }
    );
  });

  it("returns null and logs instead of forwarding an error body as audio", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const ai = {
      run: async () =>
        new Response(JSON.stringify({ name: "AiError", httpCode: 429 }), {
          status: 429
        })
    };
    const tts = new WorkersAITTS(ai as never);
    const result = await tts.synthesize("hello");
    expect(result).toBeNull();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("429"));
    errSpy.mockRestore();
  });
});

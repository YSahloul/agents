import { describe, expect, it, vi } from "vitest";
import { streamRpcVoiceTurn, type VoiceRpcCallback } from "../rpc-voice";

async function collect(source: AsyncIterable<string>): Promise<string[]> {
  const chunks: string[] = [];
  for await (const chunk of source) chunks.push(chunk);
  return chunks;
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("streamRpcVoiceTurn", () => {
  it("streams plain text from a custom RPC target", async () => {
    const source = streamRpcVoiceTurn({
      signal: new AbortController().signal,
      async run(callback) {
        callback.onText("Hello");
        await Promise.resolve();
        callback.onText(" world");
        callback.onDone();
      }
    });

    await expect(collect(source)).resolves.toEqual(["Hello", " world"]);
  });

  it("preserves text boundaries from AI SDK stream events", async () => {
    const source = streamRpcVoiceTurn({
      signal: new AbortController().signal,
      async run(callback) {
        callback.onEvent(
          JSON.stringify({ type: "text-delta", id: "a", delta: "Hello" })
        );
        callback.onEvent(
          JSON.stringify({ type: "tool-call", toolName: "search" })
        );
        callback.onEvent(
          JSON.stringify({ type: "text-delta", id: "b", delta: "world" })
        );
        callback.onDone();
      }
    });

    await expect(collect(source)).resolves.toEqual(["Hello", " ", "world"]);
  });

  it("uses the configured empty response", async () => {
    const source = streamRpcVoiceTurn({
      signal: new AbortController().signal,
      emptyResponse: "No response.",
      async run(callback) {
        callback.onDone();
      }
    });

    await expect(collect(source)).resolves.toEqual(["No response."]);
  });

  it("propagates remote errors", async () => {
    const source = streamRpcVoiceTurn({
      signal: new AbortController().signal,
      async run(callback) {
        callback.onError("remote failed");
      }
    });

    await expect(collect(source)).rejects.toThrow("remote failed");
  });

  it("cancels after an aborted turn exposes its request id", async () => {
    const controller = new AbortController();
    const completion = deferred();
    const cancel = vi.fn(async () => {});
    let callback: VoiceRpcCallback | undefined;
    const source = streamRpcVoiceTurn({
      signal: controller.signal,
      cancel,
      run(value) {
        callback = value;
        return completion.promise;
      }
    });

    controller.abort();
    callback?.onStart({ requestId: "request-1" });
    completion.resolve();

    await expect(collect(source)).resolves.toEqual([]);
    await vi.waitFor(() => {
      expect(cancel).toHaveBeenCalledWith(
        "request-1",
        "Voice turn interrupted"
      );
    });
  });
});

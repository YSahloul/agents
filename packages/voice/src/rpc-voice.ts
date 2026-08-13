import { RpcTarget } from "cloudflare:workers";
import { TextSegmentJoiner } from "agents/chat";

type Wake = () => void;

export interface VoiceRpcCallbackOptions {
  /** Called when the remote turn exposes its cancellation request id. */
  onRequestId?: (requestId: string) => void;
}

/**
 * RPC callback for streaming text from any remote agent into Voice.
 *
 * Targets that emit JSON-serialized AI SDK stream events can call `onEvent()`.
 * Other targets can call `onText()` directly.
 */
export class VoiceRpcCallback extends RpcTarget {
  readonly #onRequestId?: (requestId: string) => void;
  readonly #textSegmentJoiner = new TextSegmentJoiner();
  readonly #chunks: string[] = [];
  readonly #wakeups: Wake[] = [];
  #requestId?: string;
  #closed = false;
  #interrupted = false;
  #error?: Error;
  #text = "";

  constructor(options: VoiceRpcCallbackOptions = {}) {
    super();
    this.#onRequestId = options.onRequestId;
  }

  onStart(event: { requestId: string }): void {
    this.#requestId = event.requestId;
    this.#onRequestId?.(event.requestId);
  }

  /** Stream a plain text delta from a custom RPC target. */
  onText(text: string): void {
    if (this.#closed || !text) return;
    this.#text += text;
    this.#chunks.push(text);
    this.#wake();
  }

  /** Consume a JSON-serialized AI SDK stream event. */
  onEvent(json: string): void {
    const chunk = streamChunkFromJson(json);
    if (!chunk || this.#closed) return;

    for (const event of this.#textSegmentJoiner.pushChunk(chunk)) {
      if (event.type === "text") this.onText(event.text);
    }
  }

  onDone(): void {
    this.close();
  }

  onError(error: string): void {
    this.fail(new Error(error));
  }

  onInterrupted(): void {
    this.#interrupted = true;
    this.close();
  }

  requestId(): string | undefined {
    return this.#requestId;
  }

  hasText(): boolean {
    return this.#text.trim().length > 0;
  }

  wasInterrupted(): boolean {
    return this.#interrupted;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#wake();
  }

  fail(error: unknown): void {
    if (this.#closed) return;
    this.#error = error instanceof Error ? error : new Error(String(error));
    this.#closed = true;
    this.#wake();
  }

  async *stream(): AsyncIterable<string> {
    while (true) {
      const next = this.#chunks.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.#error) throw this.#error;
      if (this.#closed) return;
      await new Promise<void>((resolve) => this.#wakeups.push(resolve));
    }
  }

  #wake(): void {
    for (const wake of this.#wakeups.splice(0)) wake();
  }
}

export interface RpcVoiceTurnOptions {
  /** The Voice turn abort signal. */
  signal: AbortSignal;
  /** Start the remote turn and keep this promise pending until it completes. */
  run: (callback: VoiceRpcCallback) => Promise<void>;
  /** Cancel the remote turn after `onStart()` exposes its request id. */
  cancel?: (requestId: string, reason: string) => Promise<void> | void;
  /** Observe the remote request id, for logging or correlation. */
  onRequestId?: (requestId: string) => void;
  /** Spoken only when the completed remote turn produced no visible text. */
  emptyResponse?: string;
  /** Cancellation reason passed to the remote target. */
  interruptionReason?: string;
}

/**
 * Start an RPC-backed agent turn and return its text stream to `withVoice()`.
 *
 * The callback is a Workers `RpcTarget`, so the remote target can stream into
 * it while `run()` remains pending. Aborting the Voice turn closes the local
 * stream immediately and, once available, forwards the request id to
 * `cancel()`.
 */
export function streamRpcVoiceTurn(
  options: RpcVoiceTurnOptions
): AsyncIterable<string> {
  const reason = options.interruptionReason ?? "Voice turn interrupted";
  let cancelStarted = false;
  let aborted = options.signal.aborted;

  const cancelRemote = (requestId: string) => {
    if (!options.cancel || cancelStarted) return;
    cancelStarted = true;
    void Promise.resolve()
      .then(() => options.cancel?.(requestId, reason))
      .catch((error) => {
        console.error("[voice] RPC turn cancellation failed", error);
      });
  };

  const callback = new VoiceRpcCallback({
    onRequestId(requestId) {
      options.onRequestId?.(requestId);
      if (aborted) cancelRemote(requestId);
    }
  });

  const abort = () => {
    aborted = true;
    callback.close();
    const requestId = callback.requestId();
    if (requestId) cancelRemote(requestId);
  };

  options.signal.addEventListener("abort", abort, { once: true });

  let completion: Promise<void>;
  if (aborted) {
    callback.close();
    completion = Promise.resolve();
  } else {
    try {
      completion = options.run(callback);
    } catch (error) {
      callback.fail(error);
      completion = Promise.resolve();
    }
  }

  void completion.then(
    () => callback.close(),
    (error) => callback.fail(error)
  );

  return (async function* () {
    try {
      yield* callback.stream();
      if (aborted) return;
      await completion;
      if (callback.wasInterrupted()) {
        throw new Error(reason);
      }
      if (!callback.hasText() && options.emptyResponse) {
        yield options.emptyResponse;
      }
    } finally {
      options.signal.removeEventListener("abort", abort);
    }
  })();
}

function streamChunkFromJson(
  json: string
): { delta?: unknown; type?: unknown } | null {
  try {
    const chunk: unknown = JSON.parse(json);
    return typeof chunk === "object" && chunk !== null
      ? (chunk as { delta?: unknown; type?: unknown })
      : null;
  } catch {
    return null;
  }
}

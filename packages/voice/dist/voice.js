import { t as VOICE_PROTOCOL_VERSION } from "./types-RutX7tlR.js";
import { TextSegmentJoiner } from "agents/chat";
import { RpcTarget } from "cloudflare:workers";
import { Decoder } from "minimp3-wasm";
import mp3DecoderModule from "minimp3-wasm/dist/decoder.opt.wasm";
//#region src/sentence-chunker.ts
/**
* Sentence chunker — accumulates streaming text and yields speech-ready chunks.
*
* By default it emits complete sentences. A finite `maxChunkLength` also emits
* bounded phrases at clause or word boundaries, allowing TTS to start while a
* long sentence is still being generated.
*
* Isolated and testable: no dependencies on the voice pipeline, Agent, or AI
* APIs. Feed it tokens via `add()`, get back chunks via the return value. Call
* `flush()` at end-of-stream to get any remaining text.
*/
const SENTENCE_TERMINATORS = {
	".": true,
	"!": true,
	"?": true
};
const CLAUSE_TERMINATORS = {
	",": true,
	";": true,
	":": true,
	"—": true
};
/**
* Minimum character count before we'll emit a sentence.
* Prevents emitting fragments like "Dr." or "U.S." as standalone sentences,
* while still allowing short responses like "Sure thing!" to stream quickly.
*/
const MIN_SENTENCE_LENGTH = 10;
const MIN_PHRASE_LENGTH = 24;
var SentenceChunker = class {
	#buffer = "";
	/**
	* @param maxChunkLength Maximum phrase length. Omit to split only sentences.
	*/
	constructor(maxChunkLength = Number.POSITIVE_INFINITY) {
		this.maxChunkLength = maxChunkLength;
	}
	/**
	* Add a chunk of text (e.g. a streamed LLM token).
	* Returns an array of complete sentences extracted from the buffer.
	* May return 0, 1, or multiple sentences depending on the input.
	*/
	add(text) {
		this.#buffer += text;
		return this.#extractSentences();
	}
	/**
	* Flush any remaining text in the buffer as a final sentence.
	* Call this when the LLM stream ends.
	* Returns the remaining text (trimmed), or an empty array if nothing is left.
	*/
	flush() {
		const remaining = this.#buffer.trim();
		this.#buffer = "";
		if (remaining.length > 0) return [remaining];
		return [];
	}
	/**
	* Reset the chunker, discarding any buffered text.
	*/
	reset() {
		this.#buffer = "";
	}
	/** Extract every speech-ready chunk currently buffered. */
	#extractSentences() {
		const sentences = [];
		while (true) {
			const boundary = this.#findSentenceBoundary();
			if (boundary === -1) break;
			const sentence = this.#buffer.slice(0, boundary + 1).trim();
			this.#buffer = this.#buffer.slice(boundary + 1).trimStart();
			if (sentence.length > 0) sentences.push(sentence);
		}
		return sentences;
	}
	/** Return the inclusive end index of the next speech-ready chunk. */
	#findSentenceBoundary() {
		let sentenceBoundary = -1;
		for (let i = 0; i < this.#buffer.length; i++) {
			if (!SENTENCE_TERMINATORS[this.#buffer[i]]) continue;
			const nextChar = this.#buffer[i + 1];
			const candidate = this.#buffer.slice(0, i + 1).trim();
			if (candidate.length >= MIN_SENTENCE_LENGTH && (nextChar === " " || nextChar === "\n")) {
				sentenceBoundary = i;
				break;
			}
			if (nextChar === void 0 && Number.isFinite(this.maxChunkLength) && candidate.length <= this.maxChunkLength && candidate.length >= MIN_SENTENCE_LENGTH) {
				sentenceBoundary = i;
				break;
			}
		}
		if (sentenceBoundary !== -1 && sentenceBoundary + 1 <= this.maxChunkLength) return sentenceBoundary;
		if (this.#buffer.length < this.maxChunkLength) return -1;
		const limit = Math.min(this.maxChunkLength - 1, this.#buffer.length - 1);
		for (let i = limit; i >= MIN_PHRASE_LENGTH; i--) if (CLAUSE_TERMINATORS[this.#buffer[i]] && (this.#buffer[i + 1] === " " || this.#buffer[i + 1] === "\n" || this.#buffer[i + 1] === void 0)) return i;
		for (let i = limit; i >= MIN_PHRASE_LENGTH; i--) if (this.#buffer[i] === " " || this.#buffer[i] === "\n") return i - 1;
		return -1;
	}
};
//#endregion
//#region src/text-stream.ts
const warnedTextStreamSources = /* @__PURE__ */ new WeakSet();
/**
* Turn any {@link TextSource} into a lazy async generator of string chunks.
*
* - `string` → yields the string once (if non-empty).
* - `ReadableStream<string>` → yields each chunk directly.
* - `ReadableStream<Uint8Array>` → decodes and parses as newline-delimited
*   JSON (NDJSON) / SSE (`data: …` lines), extracting text from common AI
*   response formats.
* - `AsyncIterable<string>` → re-yields each chunk.
*/
async function* iterateText(source) {
	for await (const event of iterateTextEvents(source)) if (event.type === "text") yield event.text;
	else if (event.type === "error") throw toError(event.error);
}
async function* iterateTextEvents(source) {
	if (typeof source === "string") {
		if (source) yield textEvent(source);
		return;
	}
	if (hasCustomAsyncIterator(source)) {
		for await (const event of iterateAsyncTextEvents(source)) yield event;
		return;
	}
	if (source instanceof ReadableStream) {
		const reader = source.getReader();
		const first = await reader.read();
		if (first.done || first.value === void 0) return;
		if (first.value instanceof Uint8Array) {
			const peeked = first.value;
			const combined = new ReadableStream({ async start(controller) {
				controller.enqueue(peeked);
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					controller.enqueue(value);
				}
				controller.close();
			} });
			for await (const chunk of parseNDJSON(combined.getReader())) {
				const ai = chunk;
				if (ai.response) yield textEvent(ai.response);
				else if (ai.choices && ai.choices.length > 0) {
					const choice = ai.choices[0];
					if (choice.delta?.content && choice.delta?.role === "assistant") yield textEvent(choice.delta.content);
				}
			}
		} else for await (const event of iterateAsyncTextEvents(readWithFirst(first.value, reader))) yield event;
		return;
	}
	if (Symbol.asyncIterator in source) for await (const event of iterateAsyncTextEvents(source)) yield event;
}
async function* readWithFirst(first, reader) {
	yield first;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		yield value;
	}
}
function hasCustomAsyncIterator(source) {
	const iterator = source[Symbol.asyncIterator];
	if (typeof iterator !== "function") return false;
	if (!(source instanceof ReadableStream)) return true;
	return Object.prototype.hasOwnProperty.call(source, Symbol.asyncIterator) || iterator !== ReadableStream.prototype[Symbol.asyncIterator];
}
async function* iterateAsyncTextEvents(source) {
	const textSegmentJoiner = new TextSegmentJoiner();
	let hasYieldedText = false;
	for await (const chunk of source) {
		if (typeof chunk === "string") {
			warnDeprecatedTextStream(source);
			if (chunk) yield textEvent(chunk);
			continue;
		}
		if (!isRecord(chunk)) continue;
		if (chunk.type === "error") {
			if (hasYieldedText) yield { type: "boundary" };
			yield {
				type: "error",
				error: toError(chunk.error)
			};
			return;
		}
		for (const event of textSegmentJoiner.pushChunk(chunk)) {
			yield event;
			if (event.type === "text") hasYieldedText = true;
		}
	}
}
function textEvent(text) {
	return {
		type: "text",
		text
	};
}
function warnDeprecatedTextStream(source) {
	if (!source || !(source instanceof ReadableStream)) return;
	if (warnedTextStreamSources.has(source)) return;
	warnedTextStreamSources.add(source);
	console.warn("[voice] AI SDK textStream is not recommended because non-adjacent text parts may be joined incorrectly. Return result.fullStream from onTurn() instead.");
}
function toError(error) {
	if (error instanceof Error) return error;
	if (typeof error === "string") return new Error(error);
	return /* @__PURE__ */ new Error("AI SDK stream error");
}
function isRecord(value) {
	return typeof value === "object" && value !== null;
}
/**
* Parse a `ReadableStream<Uint8Array>` that contains newline-delimited JSON
* or Server-Sent Events (`data: {…}` lines).  Yields each parsed JSON object.
*
* Handles the `data: [DONE]` sentinel used by OpenAI-compatible APIs.
*/
async function* parseNDJSON(reader, leftOverBuffer = "") {
	const decoder = new TextDecoder();
	let buffer = leftOverBuffer;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) {
			const parsed = parseLine(line);
			if (parsed === "DONE") return;
			if (parsed) yield parsed;
		}
	}
	if (buffer.trim()) {
		const remaining = buffer.split("\n").filter((l) => l.trim());
		for (const line of remaining) {
			const parsed = parseLine(line);
			if (parsed === "DONE") return;
			if (parsed) yield parsed;
		}
	}
}
function parseLine(line) {
	const trimmed = line.trim();
	if (!trimmed) return null;
	if (trimmed.startsWith("data:")) {
		const json = trimmed.slice(5).trim();
		if (json === "[DONE]") return "DONE";
		try {
			return JSON.parse(json);
		} catch {
			console.warn("[voice] Skipping malformed SSE data:", json);
			return null;
		}
	}
	if (trimmed === "[DONE]") return "DONE";
	if (trimmed.startsWith(":") || trimmed.startsWith("event:") || trimmed.startsWith("id:") || trimmed.startsWith("retry:")) return null;
	try {
		return JSON.parse(trimmed);
	} catch {
		console.warn("[voice] Skipping malformed NDJSON line:", trimmed);
		return null;
	}
}
/**
* True when an error is the platform's signal that a connection (or its
* Durable Object) was torn down while an operation was in flight. A client
* can drop at any moment — including mid-`start_call` while a `keepAlive()`
* alarm write is still pending — and the runtime surfaces that as a
* retryable "Network connection lost." rejection (or a Durable Object reset).
* These are expected races during shutdown, not bugs.
*/
function isConnectionTeardownError(err) {
	if (typeof err !== "object" || err === null) return false;
	const e = err;
	const message = typeof e.message === "string" ? e.message : "";
	return e.retryable === true || message.includes("Network connection lost") || message.includes("Durable Object reset") || message.includes("Durable Object is overloaded") || message.includes("cannot access storage");
}
/**
* Run a fire-and-forget task triggered by a WebSocket message so that it can
* never surface as an unhandled rejection. Voice lifecycle handlers (start
* call, end call, interrupt, transcript emission) do async work — storage
* writes for `keepAlive()`, user-defined hooks — but are dispatched without
* being awaited from the synchronous `onMessage` handler. If the connection
* is torn down before that work settles, the rejection would otherwise be
* unhandled. Expected teardown races are swallowed; anything else is logged.
*/
function runBackground(label, fn) {
	Promise.resolve().then(fn).catch((err) => {
		if (isConnectionTeardownError(err)) return;
		console.error(`[voice] ${label} failed:`, err);
	});
}
function sendVoiceJSON(connection, data, _logPrefix, _skipLog = false) {
	const json = JSON.stringify(data);
	connection.send(json);
}
/**
* Manages per-connection audio pipeline state for voice mixins.
* Owns the Maps for audio buffers, transcriber sessions, and abort controllers.
* Does not own pipeline orchestration — that stays in each mixin.
*/
var AudioConnectionManager = class {
	#audioBuffers = /* @__PURE__ */ new Map();
	#transcriberSessions = /* @__PURE__ */ new Map();
	#activePipeline = /* @__PURE__ */ new Map();
	constructor(_logPrefix) {}
	initConnection(connectionId) {
		if (!this.#audioBuffers.has(connectionId)) this.#audioBuffers.set(connectionId, []);
	}
	isInCall(connectionId) {
		return this.#audioBuffers.has(connectionId);
	}
	cleanup(connectionId) {
		this.abortPipeline(connectionId);
		this.#audioBuffers.delete(connectionId);
		this.closeTranscriberSession(connectionId);
	}
	bufferAudio(connectionId, chunk) {
		const buffer = this.#audioBuffers.get(connectionId);
		if (!buffer) return;
		buffer.push(chunk);
		let totalBytes = 0;
		for (const buf of buffer) totalBytes += buf.byteLength;
		while (totalBytes > 96e4 && buffer.length > 1) totalBytes -= buffer.shift().byteLength;
		const session = this.#transcriberSessions.get(connectionId);
		if (session) session.feed(chunk);
	}
	clearAudioBuffer(connectionId) {
		if (this.#audioBuffers.has(connectionId)) this.#audioBuffers.set(connectionId, []);
	}
	hasTranscriberSession(connectionId) {
		return this.#transcriberSessions.has(connectionId);
	}
	startTranscriberSession(connectionId, transcriber, options) {
		const hadSession = this.closeTranscriberSession(connectionId);
		const session = transcriber.createSession(options);
		this.#transcriberSessions.set(connectionId, session);
		const buffer = this.#audioBuffers.get(connectionId);
		if (!hadSession && buffer) for (const chunk of buffer) session.feed(chunk);
		return session;
	}
	closeTranscriberSession(connectionId) {
		const session = this.#transcriberSessions.get(connectionId);
		if (!session) return false;
		session.close();
		this.#transcriberSessions.delete(connectionId);
		return true;
	}
	/**
	* Forward the agent's most recent spoken reply to the active transcriber
	* session for conversational context carryover. No-op when there is no
	* session or the provider does not implement `updateAgentContext`.
	*/
	updateAgentContext(connectionId, text) {
		this.#transcriberSessions.get(connectionId)?.updateAgentContext?.(text);
	}
	hasActivePipeline(connectionId) {
		return this.#activePipeline.has(connectionId);
	}
	/**
	* Abort any in-flight pipeline and create a new AbortController.
	* Returns the new AbortSignal.
	*/
	createPipelineAbort(connectionId) {
		this.abortPipeline(connectionId);
		const controller = new AbortController();
		this.#activePipeline.set(connectionId, controller);
		return controller.signal;
	}
	abortPipeline(connectionId) {
		const controller = this.#activePipeline.get(connectionId);
		if (!controller) return false;
		controller.abort();
		this.#activePipeline.delete(connectionId);
		return true;
	}
	/**
	* Clear a pipeline abort controller only if it still matches the
	* given signal. Prevents a finished pipeline from deleting a
	* successor pipeline's controller in a concurrent scenario.
	*/
	clearPipelineAbort(connectionId, signal) {
		if (signal) {
			const controller = this.#activePipeline.get(connectionId);
			if (controller && controller.signal === signal) this.#activePipeline.delete(connectionId);
		} else this.#activePipeline.delete(connectionId);
	}
};
//#endregion
//#region src/voice-input.ts
/**
* Voice-to-text input mixin. Adds STT-only voice input to an Agent class.
*
* Subclasses must set a `transcriber` property (or override `createTranscriber`).
* No TTS provider is needed. Override `onTranscript` to handle each
* transcribed utterance.
*
* @param Base - The Agent class to extend (e.g. `Agent`).
* @param voiceInputOptions - Optional pipeline configuration.
*
* @example
* ```typescript
* import { Agent } from "agents";
* import { withVoiceInput, WorkersAINova3STT } from "@cloudflare/voice";
*
* const InputAgent = withVoiceInput(Agent);
*
* class MyAgent extends InputAgent<Env> {
*   transcriber = new WorkersAINova3STT(this.env.AI);
*
*   onTranscript(text, connection) {
*     console.log("User said:", text);
*   }
* }
* ```
*/
function withVoiceInput(Base) {
	class VoiceInputMixin extends Base {
		#cm = new AudioConnectionManager("VoiceInput");
		#keepAliveDispose = /* @__PURE__ */ new Map();
		#startupTokens = /* @__PURE__ */ new Map();
		static #VOICE_MESSAGES = /* @__PURE__ */ new Set([
			"hello",
			"start_call",
			"end_call",
			"start_of_speech",
			"end_of_speech",
			"interrupt"
		]);
		constructor(...args) {
			super(...args);
			const _onConnect = this.onConnect?.bind(this);
			const _onClose = this.onClose?.bind(this);
			const _onMessage = this.onMessage?.bind(this);
			this.onConnect = (connection, ...rest) => {
				sendVoiceJSON(connection, {
					type: "welcome",
					protocol_version: 1
				}, "VoiceInput");
				sendVoiceJSON(connection, {
					type: "status",
					status: "idle"
				}, "VoiceInput");
				return _onConnect?.(connection, ...rest);
			};
			this.onClose = (connection, ...rest) => {
				this.#startupTokens.delete(connection.id);
				this.#releaseKeepAlive(connection.id);
				this.#cm.cleanup(connection.id);
				return _onClose?.(connection, ...rest);
			};
			this.onMessage = (connection, message) => {
				if (message instanceof ArrayBuffer) {
					this.#cm.bufferAudio(connection.id, message);
					return;
				}
				if (typeof message !== "string") return _onMessage?.(connection, message);
				let parsed;
				try {
					parsed = JSON.parse(message);
				} catch {
					return _onMessage?.(connection, message);
				}
				if (VoiceInputMixin.#VOICE_MESSAGES.has(parsed.type)) {
					switch (parsed.type) {
						case "hello": break;
						case "start_call":
							runBackground("start_call", () => this.#handleStartCall(connection));
							break;
						case "end_call":
							runBackground("end_call", () => this.#handleEndCall(connection));
							break;
						case "start_of_speech":
						case "end_of_speech": break;
						case "interrupt":
							runBackground("interrupt", () => this.#handleInterrupt(connection));
							break;
					}
					return;
				}
				return _onMessage?.(connection, message);
			};
		}
		onTranscript(_text, _connection) {}
		/**
		* Override to create a transcriber dynamically per connection.
		* Return null to fall back to the `transcriber` property.
		*/
		createTranscriber(_connection) {
			return null;
		}
		beforeCallStart(_connection) {
			return true;
		}
		onCallStart(_connection) {}
		onCallEnd(_connection) {}
		onInterrupt(_connection) {}
		afterTranscribe(transcript, _connection) {
			return transcript;
		}
		async #handleStartCall(connection) {
			if (this.#cm.isInCall(connection.id)) return;
			const startupToken = Symbol(connection.id);
			this.#startupTokens.set(connection.id, startupToken);
			this.#cm.initConnection(connection.id);
			try {
				const allowed = await this.beforeCallStart(connection);
				if (!this.#isCurrentStartup(connection.id, startupToken)) return;
				if (!allowed) {
					await this.#handleStartupFailure(connection, startupToken, void 0, "Voice call was rejected", null);
					return;
				}
				const provider = this.createTranscriber(connection) ?? this.transcriber;
				if (!provider) {
					const message = "No transcriber configured. Set 'transcriber' on your VoiceInput subclass or override createTranscriber().";
					console.error(`[VoiceInput] ${message}`);
					await this.#handleStartupFailure(connection, startupToken, void 0, message, null);
					return;
				}
				const dispose = await this.keepAlive();
				if (!this.#isCurrentStartup(connection.id, startupToken)) {
					dispose();
					return;
				}
				this.#keepAliveDispose.set(connection.id, dispose);
				this.#cm.startTranscriberSession(connection.id, provider, {
					onInterim: (text) => {
						sendVoiceJSON(connection, {
							type: "transcript_interim",
							text
						}, "VoiceInput");
					},
					onUtterance: (transcript) => {
						runBackground("emitTranscript", () => this.#emitTranscript(connection, transcript));
					}
				});
			} catch (error) {
				await this.#handleStartupFailure(connection, startupToken, error, "Voice input failed to start", "[VoiceInput] Call startup failed:");
				return;
			}
			if (!this.#isCurrentStartup(connection.id, startupToken)) return;
			this.#startupTokens.delete(connection.id);
			sendVoiceJSON(connection, {
				type: "status",
				status: "listening"
			}, "VoiceInput");
			await this.onCallStart(connection);
		}
		#isCurrentStartup(connectionId, startupToken) {
			return this.#startupTokens.get(connectionId) === startupToken && this.#cm.isInCall(connectionId);
		}
		async #handleStartupFailure(connection, startupToken, error, clientMessage, logPrefix = "[VoiceInput] Call startup failed:") {
			if (!this.#isCurrentStartup(connection.id, startupToken)) return;
			if (logPrefix && error !== void 0) console.error(logPrefix, error);
			this.#startupTokens.delete(connection.id);
			sendVoiceJSON(connection, {
				type: "error",
				message: clientMessage
			}, "VoiceInput");
			this.#cm.cleanup(connection.id);
			this.#releaseKeepAlive(connection.id);
			sendVoiceJSON(connection, {
				type: "status",
				status: "idle"
			}, "VoiceInput");
			await this.onCallEnd(connection);
		}
		#releaseKeepAlive(connectionId) {
			const dispose = this.#keepAliveDispose.get(connectionId);
			if (dispose) {
				dispose();
				this.#keepAliveDispose.delete(connectionId);
			}
		}
		#handleEndCall(connection) {
			this.#startupTokens.delete(connection.id);
			this.#cm.cleanup(connection.id);
			this.#releaseKeepAlive(connection.id);
			sendVoiceJSON(connection, {
				type: "status",
				status: "idle"
			}, "VoiceInput");
			return this.onCallEnd(connection);
		}
		#handleInterrupt(connection) {
			this.#cm.abortPipeline(connection.id);
			this.#cm.clearAudioBuffer(connection.id);
			sendVoiceJSON(connection, {
				type: "status",
				status: "listening"
			}, "VoiceInput");
			return this.onInterrupt(connection);
		}
		async #emitTranscript(connection, transcript) {
			try {
				const userText = await this.afterTranscribe(transcript, connection);
				if (!userText) return;
				sendVoiceJSON(connection, {
					type: "transcript_interim",
					text: ""
				}, "VoiceInput");
				sendVoiceJSON(connection, {
					type: "transcript",
					role: "user",
					text: userText
				}, "VoiceInput");
				await this.onTranscript(userText, connection);
			} catch (err) {
				console.error("[VoiceInput] transcript error:", err);
				sendVoiceJSON(connection, {
					type: "error",
					message: err instanceof Error ? err.message : "Transcript processing failed"
				}, "VoiceInput");
			}
			if (this.#cm.isInCall(connection.id)) sendVoiceJSON(connection, {
				type: "status",
				status: "listening"
			}, "VoiceInput");
		}
	}
	return VoiceInputMixin;
}
//#endregion
//#region src/rpc-voice.ts
/**
* RPC callback for streaming text from any remote agent into Voice.
*
* Targets that emit JSON-serialized AI SDK stream events can call `onEvent()`.
* Other targets can call `onText()` directly.
*/
var VoiceRpcCallback = class extends RpcTarget {
	#onRequestId;
	#textSegmentJoiner = new TextSegmentJoiner();
	#chunks = [];
	#wakeups = [];
	#requestId;
	#closed = false;
	#interrupted = false;
	#error;
	#text = "";
	constructor(options = {}) {
		super();
		this.#onRequestId = options.onRequestId;
	}
	onStart(event) {
		this.#requestId = event.requestId;
		this.#onRequestId?.(event.requestId);
	}
	/** Stream a plain text delta from a custom RPC target. */
	onText(text) {
		if (this.#closed || !text) return;
		this.#text += text;
		this.#chunks.push(text);
		this.#wake();
	}
	/** Consume a JSON-serialized AI SDK stream event. */
	onEvent(json) {
		const chunk = streamChunkFromJson(json);
		if (!chunk || this.#closed) return;
		for (const event of this.#textSegmentJoiner.pushChunk(chunk)) if (event.type === "text") this.onText(event.text);
	}
	onDone() {
		this.close();
	}
	onError(error) {
		this.fail(new Error(error));
	}
	onInterrupted() {
		this.#interrupted = true;
		this.close();
	}
	requestId() {
		return this.#requestId;
	}
	hasText() {
		return this.#text.trim().length > 0;
	}
	wasInterrupted() {
		return this.#interrupted;
	}
	close() {
		if (this.#closed) return;
		this.#closed = true;
		this.#wake();
	}
	fail(error) {
		if (this.#closed) return;
		this.#error = error instanceof Error ? error : new Error(String(error));
		this.#closed = true;
		this.#wake();
	}
	async *stream() {
		while (true) {
			const next = this.#chunks.shift();
			if (next !== void 0) {
				yield next;
				continue;
			}
			if (this.#error) throw this.#error;
			if (this.#closed) return;
			await new Promise((resolve) => this.#wakeups.push(resolve));
		}
	}
	#wake() {
		for (const wake of this.#wakeups.splice(0)) wake();
	}
};
/**
* Start an RPC-backed agent turn and return its text stream to `withVoice()`.
*
* The callback is a Workers `RpcTarget`, so the remote target can stream into
* it while `run()` remains pending. Aborting the Voice turn closes the local
* stream immediately and, once available, forwards the request id to
* `cancel()`.
*/
function streamRpcVoiceTurn(options) {
	const reason = options.interruptionReason ?? "Voice turn interrupted";
	let cancelStarted = false;
	let aborted = options.signal.aborted;
	const cancelRemote = (requestId) => {
		if (!options.cancel || cancelStarted) return;
		cancelStarted = true;
		Promise.resolve().then(() => options.cancel?.(requestId, reason)).catch((error) => {
			console.error("[voice] RPC turn cancellation failed", error);
		});
	};
	const callback = new VoiceRpcCallback({ onRequestId(requestId) {
		options.onRequestId?.(requestId);
		if (aborted) cancelRemote(requestId);
	} });
	const abort = () => {
		aborted = true;
		callback.close();
		const requestId = callback.requestId();
		if (requestId) cancelRemote(requestId);
	};
	options.signal.addEventListener("abort", abort, { once: true });
	let completion;
	if (aborted) {
		callback.close();
		completion = Promise.resolve();
	} else try {
		completion = options.run(callback);
	} catch (error) {
		callback.fail(error);
		completion = Promise.resolve();
	}
	completion.then(() => callback.close(), (error) => callback.fail(error));
	return (async function* () {
		try {
			yield* callback.stream();
			if (aborted) return;
			await completion;
			if (callback.wasInterrupted()) throw new Error(reason);
			if (!callback.hasText() && options.emptyResponse) yield options.emptyResponse;
		} finally {
			options.signal.removeEventListener("abort", abort);
		}
	})();
}
function streamChunkFromJson(json) {
	try {
		const chunk = JSON.parse(json);
		return typeof chunk === "object" && chunk !== null ? chunk : null;
	} catch {
		return null;
	}
}
//#endregion
//#region src/sfu-utils.ts
/**
* Pure utility functions for the Cloudflare Realtime SFU integration.
*
* Extracted from sfu.ts for testability. These handle:
* - Protobuf varint encoding/decoding
* - SFU WebSocket adapter protobuf packet encoding/decoding
* - Audio format conversion (48kHz stereo ↔ 16kHz mono)
*/
function decodeVarint(buf, offset) {
	let value = 0;
	let shift = 0;
	let bytesRead = 0;
	while (offset + bytesRead < buf.length) {
		const byte = buf[offset + bytesRead];
		value |= (byte & 127) << shift;
		bytesRead++;
		if ((byte & 128) === 0) break;
		shift += 7;
	}
	return {
		value,
		bytesRead
	};
}
function readVarint(buf, offset) {
	let value = 0;
	for (let bytesRead = 0; bytesRead < 5 && offset + bytesRead < buf.length; bytesRead++) {
		const byte = buf[offset + bytesRead];
		value |= (byte & 127) << bytesRead * 7;
		if ((byte & 128) === 0) return {
			value: value >>> 0,
			bytesRead: bytesRead + 1
		};
	}
	return null;
}
function encodeVarint(value) {
	const bytes = [];
	while (value > 127) {
		bytes.push(value & 127 | 128);
		value >>>= 7;
	}
	bytes.push(value & 127);
	return new Uint8Array(bytes);
}
/** Extract the PCM payload from a protobuf Packet message. */
function extractPayloadFromProtobuf(data) {
	const buf = new Uint8Array(data);
	let offset = 0;
	while (offset < buf.length) {
		const tag = readVarint(buf, offset);
		if (!tag) return null;
		offset += tag.bytesRead;
		const fieldNumber = tag.value >>> 3;
		const wireType = tag.value & 7;
		if (wireType === 0) {
			const value = readVarint(buf, offset);
			if (!value) return null;
			offset += value.bytesRead;
			continue;
		}
		if (wireType !== 2) return null;
		const length = readVarint(buf, offset);
		if (!length) return null;
		offset += length.bytesRead;
		if (length.value > buf.length - offset) return null;
		if (fieldNumber === 5) return buf.slice(offset, offset + length.value);
		offset += length.value;
	}
	return null;
}
/** Encode PCM payload into a protobuf Packet message (for ingest/buffer mode — just payload). */
function encodePayloadToProtobuf(payload) {
	const tagBytes = encodeVarint(42);
	const lengthBytes = encodeVarint(payload.length);
	const result = new Uint8Array(tagBytes.length + lengthBytes.length + payload.length);
	result.set(tagBytes, 0);
	result.set(lengthBytes, tagBytes.length);
	result.set(payload, tagBytes.length + lengthBytes.length);
	return result.buffer;
}
function alignedInt16(input) {
	const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
	const copy = bytes.slice(0, bytes.byteLength - bytes.byteLength % 2);
	return new Int16Array(copy.buffer);
}
function resampleLinear(input, fromRate, toRate) {
	if (input.length === 0) return /* @__PURE__ */ new Int16Array();
	const outputLength = Math.floor(input.length * toRate / fromRate);
	const output = new Int16Array(outputLength);
	const ratio = fromRate / toRate;
	for (let i = 0; i < outputLength; i++) {
		const sourceIndex = i * ratio;
		const low = Math.floor(sourceIndex);
		const high = Math.min(low + 1, input.length - 1);
		const fraction = sourceIndex - low;
		output[i] = Math.round(input[low] * (1 - fraction) + input[high] * fraction);
	}
	return output;
}
/** Convert mono PCM16 at an arbitrary sample rate to 48kHz stereo PCM16. */
function resampleMonoTo48kStereo(input, inputSampleRate) {
	const mono48k = resampleLinear(alignedInt16(input), inputSampleRate, 48e3);
	const stereo = new Int16Array(mono48k.length * 2);
	for (let i = 0; i < mono48k.length; i++) {
		stereo[i * 2] = mono48k[i];
		stereo[i * 2 + 1] = mono48k[i];
	}
	return new Uint8Array(stereo.buffer);
}
/** Downsample 48kHz stereo interleaved PCM to 16kHz mono PCM (both 16-bit LE). */
function downsample48kStereoTo16kMono(stereo48k) {
	const stereo = alignedInt16(stereo48k);
	const mono48k = new Int16Array(Math.floor(stereo.length / 2));
	for (let i = 0; i < mono48k.length; i++) mono48k[i] = Math.round((stereo[i * 2] + stereo[i * 2 + 1]) / 2);
	const samples = resampleLinear(mono48k, 48e3, 16e3);
	const output = new Uint8Array(samples.byteLength);
	output.set(new Uint8Array(samples.buffer));
	return output.buffer;
}
/** Upsample 16kHz mono PCM to 48kHz stereo interleaved PCM (both 16-bit LE). */
function upsample16kMonoTo48kStereo(mono16k) {
	return resampleMonoTo48kStereo(mono16k, 16e3);
}
/** Resample 24kHz mono PCM to 48kHz stereo interleaved PCM (both 16-bit LE). */
function resample24kMonoTo48kStereo(mono24k) {
	return resampleMonoTo48kStereo(mono24k, 24e3);
}
const DEFAULT_SFU_API_BASE = "https://rtc.live.cloudflare.com/v1";
async function requestSFU(config, operation, path, method, body) {
	const response = await fetch(`${config.apiBase ?? DEFAULT_SFU_API_BASE}/apps/${config.appId}${path}`, {
		method,
		headers: {
			Authorization: `Bearer ${config.apiToken}`,
			...body === void 0 ? {} : { "Content-Type": "application/json" }
		},
		body: body === void 0 ? void 0 : JSON.stringify(body)
	});
	if (!response.ok) throw new Error(`SFU ${operation} failed (${response.status}): ${await response.text()}`);
	return response.json();
}
function sfuFetch(config, path, body) {
	return requestSFU(config, "request", path, "POST", body);
}
async function createSFUSession(config) {
	const result = await requestSFU(config, "create session", "/sessions/new", "POST");
	if (typeof result !== "object" || result === null || !("sessionId" in result) || typeof result.sessionId !== "string") throw new Error("SFU create session response missing sessionId");
	return { sessionId: result.sessionId };
}
function addSFUTracks(config, sessionId, body) {
	return requestSFU(config, "add tracks", `/sessions/${sessionId}/tracks/new`, "POST", body);
}
function renegotiateSFUSession(config, sessionId, sessionDescription) {
	return requestSFU(config, "renegotiate session", `/sessions/${sessionId}/renegotiate`, "PUT", { sessionDescription });
}
function createSFUWebSocketAdapter(config, tracks) {
	return requestSFU(config, "create WebSocket adapter", "/adapters/websocket/new", "POST", { tracks });
}
async function closeSFUWebSocketAdapter(config, adapterId) {
	const response = await fetch(`${config.apiBase ?? DEFAULT_SFU_API_BASE}/apps/${config.appId}/adapters/websocket/close`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${config.apiToken}`,
			"Content-Type": "application/json"
		},
		body: JSON.stringify({ tracks: [{ adapterId }] })
	});
	const text = await response.text();
	if (response.ok) return { alreadyClosed: false };
	if (response.status === 503) try {
		const result = JSON.parse(text);
		if (typeof result === "object" && result !== null && "tracks" in result && Array.isArray(result.tracks) && typeof result.tracks[0] === "object" && result.tracks[0] !== null && "errorCode" in result.tracks[0] && result.tracks[0].errorCode === "adapter_not_found") return { alreadyClosed: true };
	} catch {}
	throw new Error(`SFU close WebSocket adapter failed (${response.status}): ${text}`);
}
//#endregion
//#region src/sfu-transport.ts
const FRAME_BYTES = 3840;
const FRAME_INTERVAL_MS = 20;
function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}
var SFUVoiceTransport = class {
	#config;
	#routePrefix;
	#inputSampleRate;
	#loadStateCallback;
	#saveStateCallback;
	#state = null;
	#stateLoaded = false;
	#stateLoad = null;
	#stateWrite = Promise.resolve();
	#connectionId = null;
	#onAudio = null;
	#ttsSocket = null;
	#sttSockets = /* @__PURE__ */ new Set();
	#socketWaiters = /* @__PURE__ */ new Set();
	#sttFrameCount = 0;
	#sttPeak = 0;
	#queue = [];
	#partialFrame = /* @__PURE__ */ new Uint8Array();
	#partialInputByte = null;
	#pacingTimer = null;
	constructor(options) {
		this.#config = options.config;
		this.#routePrefix = options.routePrefix?.replace(/^\/+|\/+$/g, "") || "voice";
		this.#inputSampleRate = options.inputSampleRate ?? 24e3;
		if (this.#inputSampleRate <= 0) throw new Error("SFU voice inputSampleRate must be greater than zero");
		this.#loadStateCallback = options.loadState;
		this.#saveStateCallback = options.saveState;
	}
	async start(connectionId, onAudio) {
		if (this.#connectionId && this.#connectionId !== connectionId) throw new Error("SFU voice transport already has an active call");
		this.#connectionId = connectionId;
		this.#onAudio = onAudio;
		this.#sttFrameCount = 0;
		this.#sttPeak = 0;
		this.#partialInputByte = null;
		try {
			await this.#waitForTtsSocket(1e4);
		} catch (error) {
			if (this.#connectionId === connectionId) {
				this.#connectionId = null;
				this.#onAudio = null;
			}
			throw error;
		}
	}
	send(connectionId, audio) {
		this.#requireActiveConnection(connectionId);
		this.#requireTtsSocket();
		const input = new Uint8Array(audio);
		let alignedAudio = audio;
		if (this.#partialInputByte !== null) {
			const combined = new Uint8Array(input.byteLength + 1);
			combined[0] = this.#partialInputByte;
			combined.set(input, 1);
			const alignedLength = combined.byteLength - combined.byteLength % 2;
			this.#partialInputByte = alignedLength < combined.byteLength ? combined[alignedLength] : null;
			alignedAudio = combined.slice(0, alignedLength).buffer;
		} else if (input.byteLength % 2 !== 0) {
			this.#partialInputByte = input[input.byteLength - 1];
			alignedAudio = input.slice(0, -1).buffer;
		}
		const converted = resampleMonoTo48kStereo(alignedAudio, this.#inputSampleRate);
		if (converted.byteLength === 0) return;
		const combined = new Uint8Array(this.#partialFrame.byteLength + converted.byteLength);
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
	flush(connectionId) {
		this.#requireActiveConnection(connectionId);
		this.#requireTtsSocket();
		this.#partialInputByte = null;
		if (this.#partialFrame.byteLength > 0) {
			const frame = new Uint8Array(FRAME_BYTES);
			frame.set(this.#partialFrame);
			this.#queue.push(frame);
			this.#partialFrame = /* @__PURE__ */ new Uint8Array();
		}
		return new Promise((resolve, reject) => {
			this.#queue.push({
				resolve,
				reject
			});
			console.log("[VoiceTrace]", {
				event: "sfu_flush_queued",
				connectionId,
				queuedAudioMs: this.#queue.filter((item) => item instanceof Uint8Array).length * FRAME_INTERVAL_MS
			});
			this.#startPacing();
		});
	}
	interrupt(connectionId) {
		this.#requireActiveConnection(connectionId);
		const droppedAudioMs = this.#queue.filter((item) => item instanceof Uint8Array).length * FRAME_INTERVAL_MS;
		const socket = this.#requireTtsSocket();
		this.#clearPacing();
		this.#rejectQueue(/* @__PURE__ */ new Error("SFU output interrupted"));
		this.#partialFrame = /* @__PURE__ */ new Uint8Array();
		this.#partialInputByte = null;
		socket.send(encodePayloadToProtobuf(/* @__PURE__ */ new Uint8Array()));
		console.log("[VoiceTrace]", {
			event: "sfu_interrupt",
			connectionId,
			droppedAudioMs
		});
	}
	async stop(connectionId) {
		if (this.#connectionId !== connectionId) return;
		this.#connectionId = null;
		this.#onAudio = null;
		this.#clearPacing();
		this.#rejectQueue(/* @__PURE__ */ new Error("SFU voice transport stopped"));
		this.#partialFrame = /* @__PURE__ */ new Uint8Array();
		this.#partialInputByte = null;
		this.#rejectSocketWaiters(/* @__PURE__ */ new Error("SFU voice transport stopped"));
		const adapterIds = [];
		await this.#updateState((state) => {
			for (const adapterId of [state?.tts?.adapterId, state?.stt?.adapterId]) if (adapterId) adapterIds.push(adapterId);
			return null;
		});
		await Promise.all(adapterIds.map((adapterId) => this.#closeAdapter(adapterId)));
		if (this.#ttsSocket) {
			this.#ttsSocket.close(1e3, "Voice stopped");
			this.#ttsSocket = null;
		}
		for (const socket of this.#sttSockets) socket.close(1e3, "Voice stopped");
		this.#sttSockets.clear();
	}
	handleWebSocketUpgrade(request) {
		if (request.method !== "GET" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return null;
		const path = new URL(request.url).pathname;
		if (path.endsWith(this.#route("tts/subscribe"))) return this.#handleTtsSubscribe();
		if (path.endsWith(this.#route("stt/sfu-subscribe"))) return this.#handleSttSubscribe();
		return null;
	}
	async handleHttpRequest(request) {
		if (request.method !== "POST") return null;
		const path = new URL(request.url).pathname;
		if (path.endsWith(this.#route("tts/publish"))) return this.#respond("TTS publish", () => this.#publishTts(request));
		if (path.endsWith(this.#route("rtc/connect"))) return this.#respond("RTC connect", () => this.#connectRtc(request));
		if (path.endsWith(this.#route("rtc/pull"))) return this.#respond("RTC pull", () => this.#pullTts());
		if (path.endsWith(this.#route("rtc/renegotiate"))) return this.#respond("RTC renegotiate", () => this.#renegotiateRtc(request));
		if (path.endsWith(this.#route("stt/start-forwarding"))) return this.#respond("STT start forwarding", () => this.#startSttForwarding());
		if (path.endsWith(this.#route("stt/stop-forwarding"))) return this.#respond("STT stop forwarding", () => this.#stopSttForwarding());
		return null;
	}
	async #respond(operation, handler) {
		try {
			return await handler();
		} catch (error) {
			console.error(`[SFUVoiceTransport] ${operation} failed:`, error);
			return new Response(`${operation} failed: ${errorMessage(error)}`, { status: 500 });
		}
	}
	async #publishTts(request) {
		let previousAdapterId;
		await this.#updateState((state) => {
			previousAdapterId = state?.tts?.adapterId;
			return state?.stt ? { stt: state.stt } : null;
		});
		if (previousAdapterId) await this.#closeAdapter(previousAdapterId);
		const callbackUrl = this.#callbackUrl(request, "tts/publish", "tts/subscribe");
		const MAX_ATTEMPTS = 3;
		for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
			const trackName = `tts-${crypto.randomUUID()}`;
			const result = await createSFUWebSocketAdapter(this.#config, [{
				location: "local",
				trackName,
				endpoint: callbackUrl,
				inputCodec: "pcm",
				mode: "buffer"
			}]);
			const response = this.#asResponse(result, "create WebSocket adapter");
			const firstTrack = this.#firstTrack(response, "create WebSocket adapter");
			if (typeof firstTrack.sessionId !== "string" || typeof firstTrack.adapterId !== "string") throw new Error("SFU create WebSocket adapter response missing tracks[0].sessionId or tracks[0].adapterId");
			await this.#updateState((current) => ({
				...current ?? {},
				tts: {
					sessionId: firstTrack.sessionId,
					adapterId: firstTrack.adapterId,
					trackName
				}
			}));
			try {
				await this.#waitForTtsSocket(5e3);
				this.#requireTtsSocket().send(encodePayloadToProtobuf(new Uint8Array(FRAME_BYTES)));
				return Response.json({
					...response,
					sessionId: firstTrack.sessionId,
					adapterId: firstTrack.adapterId,
					trackName
				});
			} catch {
				if (attempt < MAX_ATTEMPTS) {
					console.warn(`[SFUVoiceTransport] TTS callback timeout, retrying (attempt ${attempt}/${MAX_ATTEMPTS})`);
					if (this.#ttsSocket) {
						this.#ttsSocket.close(1e3, "Retry");
						this.#ttsSocket = null;
					}
					await this.#closeAdapter(firstTrack.adapterId);
				}
			}
		}
		throw new Error("SFU TTS callback timeout after all retry attempts");
	}
	async #connectRtc(request) {
		const connect = await this.#readRtcConnect(request);
		if (!connect) return new Response("Missing sessionDescription.sdp or microphoneMid", { status: 400 });
		const { sessionId } = await createSFUSession(this.#config);
		const microphoneTrackName = `stt-${crypto.randomUUID()}`;
		const result = await addSFUTracks(this.#config, sessionId, {
			sessionDescription: connect.sessionDescription,
			tracks: [{
				location: "local",
				mid: connect.microphoneMid,
				trackName: microphoneTrackName,
				kind: "audio"
			}]
		});
		const response = this.#asResponse(result, "connect RTC session");
		if (!this.#normalizeSessionDescription(response)) throw new Error("SFU connect RTC session response missing sessionDescription.sdp");
		const callbackUrl = this.#callbackUrl(request, "rtc/connect", "stt/sfu-subscribe");
		await this.#updateState((current) => ({
			...current ?? {},
			stt: {
				sessionId,
				trackName: microphoneTrackName,
				callbackUrl
			}
		}));
		return Response.json(response);
	}
	async #pullTts() {
		const state = await this.#loadState();
		if (!state?.tts) return new Response("TTS not published yet", { status: 400 });
		if (!state.stt) return new Response("RTC session not connected yet", { status: 400 });
		for (let attempt = 0;; attempt++) {
			const result = await addSFUTracks(this.#config, state.stt.sessionId, { tracks: [{
				location: "remote",
				sessionId: state.tts.sessionId,
				trackName: state.tts.trackName,
				kind: "audio"
			}] });
			const response = this.#asResponse(result, "pull TTS track");
			const firstTrack = this.#firstTrack(response, "pull TTS track");
			if (!("errorCode" in firstTrack)) return Response.json(response);
			if (firstTrack.errorCode === "empty_track_error" && attempt < 4) {
				await new Promise((resolve) => setTimeout(resolve, FRAME_INTERVAL_MS * (attempt + 1)));
				continue;
			}
			throw new Error(`SFU pull TTS track failed: ${String(firstTrack.errorCode)}`);
		}
	}
	async #renegotiateRtc(request) {
		const state = await this.#loadState();
		if (!state?.stt?.sessionId) return new Response("No RTC session to renegotiate. Call connect first.", { status: 400 });
		const description = await this.#readSessionDescription(request);
		if (!description) return new Response("Missing sessionDescription.sdp", { status: 400 });
		const result = await renegotiateSFUSession(this.#config, state.stt.sessionId, description);
		return Response.json(result);
	}
	async #startSttForwarding() {
		const state = await this.#loadState();
		if (!state?.stt) return new Response("STT not connected yet", { status: 400 });
		if (state.stt.adapterId) return new Response("Forwarding already active");
		const result = await createSFUWebSocketAdapter(this.#config, [{
			location: "remote",
			sessionId: state.stt.sessionId,
			trackName: state.stt.trackName,
			endpoint: state.stt.callbackUrl,
			outputCodec: "pcm"
		}]);
		const response = this.#asResponse(result, "start STT forwarding");
		const firstTrack = this.#firstTrack(response, "start STT forwarding");
		if (typeof firstTrack.adapterId !== "string") throw new Error("SFU start STT forwarding response missing tracks[0].adapterId");
		await this.#updateState((current) => {
			if (!current?.stt) return current;
			return {
				...current,
				stt: {
					...current.stt,
					adapterId: firstTrack.adapterId
				}
			};
		});
		return new Response("Forwarding started");
	}
	async #stopSttForwarding() {
		let adapterId;
		await this.#updateState((state) => {
			adapterId = state?.stt?.adapterId;
			if (!state?.stt || !adapterId) return state;
			const stt = { ...state.stt };
			delete stt.adapterId;
			return {
				...state,
				stt
			};
		});
		if (!adapterId) return new Response("Forwarding not active");
		await this.#closeAdapter(adapterId);
		return new Response("Forwarding stopped");
	}
	#handleTtsSubscribe() {
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
			this.#ttsSocket.close(1e3, "Replaced");
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
		server.addEventListener("error", (event) => {
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
		});
	}
	#handleSttSubscribe() {
		const { 0: client, 1: server } = new WebSocketPair();
		server.accept();
		server.binaryType = "arraybuffer";
		this.#sttSockets.add(server);
		server.addEventListener("message", (event) => {
			if (!(event.data instanceof ArrayBuffer)) return;
			const payload = extractPayloadFromProtobuf(event.data);
			if (!payload || payload.byteLength === 0) return;
			const samples = new Int16Array(payload.buffer);
			let peak = 0;
			for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
			this.#sttFrameCount++;
			this.#sttPeak = Math.max(this.#sttPeak, peak);
			if (this.#sttFrameCount === 1 || this.#sttFrameCount % 250 === 0) console.log("[VoiceTrace]", {
				event: "sfu_stt_audio",
				connectionId: this.#connectionId,
				frames: this.#sttFrameCount,
				bytes: payload.byteLength,
				peak: this.#sttPeak
			});
			const callback = this.#onAudio;
			if (!callback) return;
			callback(downsample48kStereoTo16kMono(payload));
		});
		server.addEventListener("close", () => this.#sttSockets.delete(server));
		server.addEventListener("error", (event) => {
			console.error("[SFUVoiceTransport] STT callback socket error:", event);
			this.#sttSockets.delete(server);
		});
		return new Response(null, {
			status: 101,
			webSocket: client
		});
	}
	#startPacing() {
		if (this.#pacingTimer || this.#queue.length === 0) return;
		this.#pacingTimer = setInterval(() => {
			const socket = this.#ttsSocket;
			if (!socket || socket.readyState !== WebSocket.OPEN) {
				this.#clearTtsSocket(socket);
				return;
			}
			const item = this.#queue.shift();
			if (item === void 0) {
				this.#clearPacing();
				return;
			}
			if (item instanceof Uint8Array) socket.send(encodePayloadToProtobuf(item));
			else {
				socket.send(encodePayloadToProtobuf(/* @__PURE__ */ new Uint8Array()));
				item.resolve();
				console.log("[VoiceTrace]", {
					event: "sfu_flush_sent",
					connectionId: this.#connectionId,
					remainingAudioMs: this.#queue.filter((queued) => queued instanceof Uint8Array).length * FRAME_INTERVAL_MS
				});
			}
			if (this.#queue.length === 0) this.#clearPacing();
		}, FRAME_INTERVAL_MS);
	}
	#clearPacing() {
		if (!this.#pacingTimer) return;
		clearInterval(this.#pacingTimer);
		this.#pacingTimer = null;
	}
	#rejectQueue(error) {
		const queue = this.#queue.splice(0);
		for (const item of queue) if (!(item instanceof Uint8Array)) item.reject(error);
	}
	#clearTtsSocket(socket) {
		if (!socket || this.#ttsSocket !== socket) return;
		this.#ttsSocket = null;
		this.#clearPacing();
		this.#rejectQueue(/* @__PURE__ */ new Error("SFU TTS socket closed"));
		this.#partialFrame = /* @__PURE__ */ new Uint8Array();
		this.#partialInputByte = null;
	}
	#requireActiveConnection(connectionId) {
		if (this.#connectionId !== connectionId) throw new Error("SFU voice transport connection is not active");
	}
	#requireTtsSocket() {
		if (!this.#ttsSocket || this.#ttsSocket.readyState !== WebSocket.OPEN) throw new Error("SFU TTS socket is not connected");
		return this.#ttsSocket;
	}
	#waitForTtsSocket(timeoutMs) {
		if (this.#ttsSocket?.readyState === WebSocket.OPEN) return Promise.resolve();
		return new Promise((resolve, reject) => {
			const waiter = {
				resolve: () => {
					clearTimeout(waiter.timer);
					this.#socketWaiters.delete(waiter);
					resolve();
				},
				reject: (error) => {
					clearTimeout(waiter.timer);
					this.#socketWaiters.delete(waiter);
					reject(error);
				},
				timer: setTimeout(() => {
					this.#socketWaiters.delete(waiter);
					reject(/* @__PURE__ */ new Error(`SFU TTS callback timeout after ${timeoutMs / 1e3}s`));
				}, timeoutMs)
			};
			this.#socketWaiters.add(waiter);
		});
	}
	#resolveSocketWaiters() {
		for (const waiter of [...this.#socketWaiters]) waiter.resolve();
	}
	#rejectSocketWaiters(error) {
		for (const waiter of [...this.#socketWaiters]) waiter.reject(error);
	}
	async #loadState() {
		if (this.#stateLoaded) return this.#state;
		if (this.#stateLoad) return this.#stateLoad;
		this.#stateLoad = (async () => {
			const state = await this.#loadStateCallback?.() ?? null;
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
	async #replaceState(state) {
		await this.#saveStateCallback?.(state);
		this.#state = state;
		this.#stateLoaded = true;
	}
	#updateState(update) {
		const write = this.#stateWrite.then(async () => {
			const current = await this.#loadState();
			await this.#replaceState(update(current));
		});
		this.#stateWrite = write.catch(() => {});
		return write;
	}
	async #readRtcConnect(request) {
		let body;
		try {
			body = await request.json();
		} catch {
			return null;
		}
		if (typeof body !== "object" || body === null || !("sessionDescription" in body) || typeof body.sessionDescription !== "object" || body.sessionDescription === null || !("sdp" in body.sessionDescription) || typeof body.sessionDescription.sdp !== "string" || body.sessionDescription.sdp.length === 0 || !("microphoneMid" in body) || typeof body.microphoneMid !== "string" || body.microphoneMid.length === 0) return null;
		return {
			sessionDescription: {
				type: "type" in body.sessionDescription && typeof body.sessionDescription.type === "string" ? body.sessionDescription.type : void 0,
				sdp: body.sessionDescription.sdp
			},
			microphoneMid: body.microphoneMid
		};
	}
	async #readSessionDescription(request) {
		let body;
		try {
			body = await request.json();
		} catch {
			return null;
		}
		if (typeof body !== "object" || body === null || !("sessionDescription" in body) || typeof body.sessionDescription !== "object" || body.sessionDescription === null || !("sdp" in body.sessionDescription) || typeof body.sessionDescription.sdp !== "string") return null;
		return {
			type: "type" in body.sessionDescription && typeof body.sessionDescription.type === "string" ? body.sessionDescription.type : void 0,
			sdp: body.sessionDescription.sdp
		};
	}
	#asResponse(value, operation) {
		if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`SFU ${operation} response must be an object`);
		return value;
	}
	#firstTrack(response, operation) {
		if (!Array.isArray(response.tracks) || typeof response.tracks[0] !== "object" || response.tracks[0] === null || Array.isArray(response.tracks[0])) throw new Error(`SFU ${operation} response missing tracks[0]`);
		return response.tracks[0];
	}
	#normalizeSessionDescription(response) {
		if (typeof response.sessionDescription !== "object" || response.sessionDescription === null || !("sdp" in response.sessionDescription) || typeof response.sessionDescription.sdp !== "string") return false;
		const description = response.sessionDescription;
		if (typeof description.type !== "string") description.type = "answer";
		return true;
	}
	async #closeAdapter(adapterId) {
		try {
			await closeSFUWebSocketAdapter(this.#config, adapterId);
		} catch (error) {
			console.warn("[SFUVoiceTransport] Adapter cleanup failed:", error);
		}
	}
	#route(operation) {
		return `/${this.#routePrefix}/${operation}`;
	}
	#callbackUrl(request, from, to) {
		const url = new URL(request.url);
		const fromSuffix = this.#route(from);
		url.pathname = `${url.pathname.slice(0, -fromSuffix.length)}${this.#route(to)}`;
		url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
		return url.toString();
	}
};
//#endregion
//#region src/sfu-voice.ts
const SFU_STATE_KEY = "cf_voice_sfu_state";
function withSFUVoice(Base, options) {
	const { routePrefix, ...voiceOptions } = options ?? {};
	const normalizedPrefix = routePrefix?.replace(/^\/+|\/+$/g, "") || "voice";
	const VoiceBase = withVoice(Base, {
		...voiceOptions,
		audioFormat: "pcm16",
		sampleRate: voiceOptions.sampleRate ?? 24e3
	});
	class SFUVoiceAgentMixin extends VoiceBase {
		#transport = null;
		constructor(...args) {
			super(...args);
			const consumerFetch = this.fetch.bind(this);
			this.fetch = async (request) => {
				const path = new URL(request.url).pathname;
				if (request.method === "GET" && request.headers.get("Upgrade")?.toLowerCase() === "websocket" && (path.endsWith(`/${normalizedPrefix}/tts/subscribe`) || path.endsWith(`/${normalizedPrefix}/stt/sfu-subscribe`))) {
					const response = this.#getSFUTransport().handleWebSocketUpgrade(request);
					if (response) return response;
				}
				return consumerFetch(request);
			};
			const consumerOnRequest = this.onRequest.bind(this);
			this.onRequest = async (request) => {
				const path = new URL(request.url).pathname;
				if (request.method === "POST" && [
					"tts/publish",
					"rtc/connect",
					"rtc/pull",
					"rtc/renegotiate",
					"stt/start-forwarding",
					"stt/stop-forwarding"
				].some((operation) => path.endsWith(`/${normalizedPrefix}/${operation}`))) {
					const response = await this.#getSFUTransport().handleHttpRequest(request);
					if (response) return response;
				}
				return consumerOnRequest(request);
			};
		}
		getSFUConfig() {
			throw new Error("SFU voice agent must implement getSFUConfig()");
		}
		createAudioTransport(_connection) {
			return this.#getSFUTransport();
		}
		#getSFUTransport() {
			this.#transport ??= new SFUVoiceTransport({
				config: this.getSFUConfig(),
				routePrefix: normalizedPrefix,
				inputSampleRate: voiceOptions.sampleRate ?? 24e3,
				loadState: async () => await this.ctx.storage.get(SFU_STATE_KEY) ?? null,
				saveState: async (state) => {
					if (state) await this.ctx.storage.put(SFU_STATE_KEY, state);
					else await this.ctx.storage.delete(SFU_STATE_KEY);
				}
			});
			return this.#transport;
		}
	}
	return SFUVoiceAgentMixin;
}
//#endregion
//#region src/voice-agent-factory.ts
/**
* Config-driven voice agent mixin. Composes `withVoice()` — same pipeline,
* same protocol — with STT/TTS provider construction, a default greeting,
* and per-call props handling collapsed into a config object. `onTurn()`
* is still a required subclass override (the library has no LLM/model
* dependency); everything else about `withVoice()`-based agents (further
* subclassing, lifecycle hook overrides) still applies.
*
* Usage:
*   const VoiceAgent = createVoiceAgent(Agent, {
*     stt: (env: Env) => new WorkersAIFluxSTT(env.AI, { eotThreshold: 0.7 }),
*     tts: (env: Env) => new WorkersAIRealtimeTTS(env.AI),
*     greeting: "Hello! How can I help you today?"
*   });
*
*   class MyAgent extends VoiceAgent<Env> {
*     async onTurn(transcript, context) { ... this.callProps ... }
*   }
*
* @experimental This API is not yet stable and may change.
*/
function createVoiceAgent(Base, config) {
	const { stt: sttFactory, tts: ttsFactory, greeting, ...voiceOptions } = config;
	const VoiceBase = withVoice(Base, voiceOptions);
	class VoiceAgentFactoryMixin extends VoiceBase {
		constructor(..._args) {
			super(..._args);
			this.transcriber = sttFactory(this.env);
			this.tts = ttsFactory(this.env);
		}
		async onStart(props) {
			if (props) this.callProps = props;
		}
		async onCallStart(connection) {
			if (greeting) await this.speak(connection, greeting);
		}
	}
	return VoiceAgentFactoryMixin;
}
//#endregion
//#region src/workers-ai-providers.ts
/**
* Workers AI provider implementations for the voice pipeline.
*
* These are convenience classes that wrap the Workers AI binding
* (env.AI) for STT and TTS. They are not required — any object
* satisfying the provider interfaces works.
*/
/**
* Workers AI text-to-speech provider.
*
* @example
* ```ts
* class MyAgent extends VoiceAgent<Env> {
*   tts = new WorkersAITTS(this.env.AI);
* }
* ```
*/
var WorkersAITTS = class {
	#ai;
	#model;
	#speaker;
	#encoding;
	#container;
	#sampleRate;
	constructor(ai, options) {
		this.#ai = ai;
		this.#model = options?.model ?? "@cf/deepgram/aura-1";
		this.#speaker = options?.speaker ?? "asteria";
		this.#encoding = options?.encoding;
		this.#container = options?.container;
		this.#sampleRate = options?.sampleRate;
	}
	async synthesize(text, signal) {
		const input = {
			text,
			speaker: this.#speaker
		};
		if (this.#encoding !== void 0) input.encoding = this.#encoding;
		if (this.#container !== void 0) input.container = this.#container;
		if (this.#sampleRate !== void 0) input.sample_rate = this.#sampleRate;
		const response = await this.#ai.run(this.#model, input, {
			returnRawResponse: true,
			...signal ? { signal } : {}
		});
		if (!response.ok) {
			const body = await response.text().catch(() => "");
			console.error(`[WorkersAITTS] TTS request failed: HTTP ${response.status}${body ? ` — ${body.slice(0, 200)}` : ""}`);
			return null;
		}
		return await response.arrayBuffer();
	}
};
/**
* Workers AI text-to-speech over the binding's native WebSocket mode
* (`env.AI.run(model, input, { websocket: true })`).
*
* Implements {@link StreamingTTSProvider}: one socket per sentence, and the
* generator returning *is* completion. Interruption is the consumer abandoning
* the iterator (or aborting the signal), which closes the socket.
*
* Inherits {@link WorkersAITTS.synthesize} as the non-streaming fallback.
*
* @example
* ```ts
* class MyAgent extends VoiceAgent<Env> {
*   tts = new WorkersAIRealtimeTTS(this.env.AI);
* }
* ```
*/
var WorkersAIRealtimeTTS = class extends WorkersAITTS {
	#ai;
	#model;
	#speaker;
	#encoding;
	constructor(ai, options) {
		const model = options?.model ?? "@cf/deepgram/aura-2-en";
		const speaker = options?.speaker ?? "asteria";
		const encoding = options?.encoding ?? "mulaw";
		const sampleRate = options?.sampleRate ?? (encoding === "mulaw" ? 8e3 : 24e3);
		if (!(encoding === "mulaw" && sampleRate === 8e3 || encoding === "linear16" && sampleRate === 24e3)) throw new Error("Workers AI realtime TTS supports only mulaw/8000 or linear16/24000");
		super(ai, {
			model,
			speaker,
			encoding,
			sampleRate,
			container: "none"
		});
		this.audioFormat = encoding === "mulaw" ? "mulaw" : "pcm16";
		this.sampleRate = sampleRate;
		this.#ai = ai;
		this.#model = model;
		this.#speaker = speaker;
		this.#encoding = encoding;
	}
	async *synthesizeStream(text, signal) {
		if (!text || signal?.aborted) return;
		const ws = await this.#open();
		const sampleBytes = this.#encoding === "mulaw" ? 1 : 2;
		const frames = new AudioFrameStream(this.sampleRate * FRAME_MS * sampleBytes / 1e3, sampleBytes);
		ws.addEventListener("message", (event) => {
			if (typeof event.data === "string") {
				try {
					const message = JSON.parse(event.data);
					if (message && typeof message === "object" && "type" in message && message.type === "Flushed") frames.finish();
				} catch {}
				return;
			}
			if (event.data instanceof ArrayBuffer) frames.push(new Uint8Array(event.data));
			else if (ArrayBuffer.isView(event.data)) {
				const view = event.data;
				frames.push(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
			}
		});
		ws.addEventListener("close", (event) => {
			frames.fail(/* @__PURE__ */ new Error(`Workers AI realtime TTS socket closed before flush (code ${event.code}${event.reason ? `: ${event.reason}` : ""})`));
		});
		ws.addEventListener("error", () => {
			frames.fail(/* @__PURE__ */ new Error("Workers AI realtime TTS socket error"));
		});
		try {
			ws.send(JSON.stringify({
				type: "Speak",
				text,
				speaker: this.#speaker
			}));
			ws.send(JSON.stringify({ type: "Flush" }));
			let nextYieldAt = 0;
			for await (const frame of frames) {
				if (signal?.aborted) return;
				const now = Date.now();
				if (nextYieldAt === 0) nextYieldAt = now + FRAME_MS;
				else {
					if (now < nextYieldAt) await new Promise((resolve) => setTimeout(resolve, nextYieldAt - now));
					nextYieldAt = Math.max(nextYieldAt + FRAME_MS, Date.now() + FRAME_MS);
				}
				yield frame;
			}
		} finally {
			try {
				ws.close();
			} catch {}
		}
	}
	async #open() {
		const response = await this.#ai.run(this.#model, {
			encoding: this.#encoding,
			sample_rate: String(this.sampleRate),
			speaker: this.#speaker,
			container: "none"
		}, { websocket: true });
		if (!response || typeof response !== "object" || !("webSocket" in response) || !isWebSocket(response.webSocket)) throw new Error("Workers AI realtime TTS did not return a WebSocket");
		const ws = response.webSocket;
		ws.accept();
		ws.binaryType = "arraybuffer";
		return ws;
	}
};
/** Incrementally exposes new mono PCM16 samples from an MP3 byte stream. */
var StreamingMp3ToPcm16 = class {
	#chunks = [];
	#byteLength = 0;
	#emittedFrames = 0;
	constructor(wasm, sampleRate) {
		this.wasm = wasm;
		this.sampleRate = sampleRate;
	}
	push(chunk) {
		this.#chunks.push(chunk);
		this.#byteLength += chunk.byteLength;
		const mp3 = new Uint8Array(this.#byteLength);
		let offset = 0;
		for (const buffered of this.#chunks) {
			mp3.set(buffered, offset);
			offset += buffered.byteLength;
		}
		const result = new Decoder(this.wasm, mp3).decode(Number.POSITIVE_INFINITY);
		if (result.samplingRate !== 0 && result.samplingRate !== this.sampleRate) throw new Error(`MP3 stream returned ${result.samplingRate} Hz audio; expected ${this.sampleRate} Hz`);
		if (result.numChannels < 1) return null;
		const decodedFrames = Math.floor(result.numSamples / result.numChannels);
		if (decodedFrames <= this.#emittedFrames) return null;
		const pcm = new Int16Array(decodedFrames - this.#emittedFrames);
		for (let frame = this.#emittedFrames; frame < decodedFrames; frame++) {
			let sample = 0;
			for (let channel = 0; channel < result.numChannels; channel++) sample += result.pcm[frame * result.numChannels + channel] ?? 0;
			pcm[frame - this.#emittedFrames] = Math.round(sample / result.numChannels);
		}
		this.#emittedFrames = decodedFrames;
		return new Uint8Array(pcm.buffer);
	}
};
/**
* Streaming xAI Grok TTS through the Workers AI binding.
*
* Grok's MP3 WebSocket output is decoded to PCM16 as each chunk arrives, so
* callers do not need an xAI API key or a complete audio download.
*/
var WorkersAIGrokTTS = class {
	#ai;
	#voice;
	#language;
	#optimizeStreamingLatency;
	constructor(ai, options) {
		this.audioFormat = "pcm16";
		this.sampleRate = 24e3;
		this.#ai = ai;
		this.#voice = options?.voice ?? "ara";
		this.#language = options?.language ?? "en";
		this.#optimizeStreamingLatency = options?.optimizeStreamingLatency ?? 1;
	}
	async synthesize(text, signal) {
		const chunks = [];
		let byteLength = 0;
		for await (const chunk of this.synthesizeStream(text, signal)) {
			chunks.push(chunk);
			byteLength += chunk.byteLength;
		}
		if (chunks.length === 0) return null;
		const audio = new Uint8Array(byteLength);
		let offset = 0;
		for (const chunk of chunks) {
			audio.set(new Uint8Array(chunk), offset);
			offset += chunk.byteLength;
		}
		return audio.buffer;
	}
	async *synthesizeStream(text, signal) {
		if (!text || signal?.aborted) return;
		const source = new ReadableStream({ start(controller) {
			controller.enqueue(text);
			controller.close();
		} });
		yield* this.synthesizeTextStream(source, signal);
	}
	async *synthesizeTextStream(text, signal) {
		if (signal?.aborted) return;
		const [decoderInstance, ws] = await Promise.all([WebAssembly.instantiate(mp3DecoderModule, {}), this.#open()]);
		const frames = new AudioFrameStream(this.sampleRate * FRAME_MS * 2 / 1e3, 2);
		const normalizer = new StreamingMp3ToPcm16(decoderInstance.exports, this.sampleRate);
		ws.addEventListener("message", (event) => {
			if (typeof event.data !== "string") return;
			let message;
			try {
				message = JSON.parse(event.data);
			} catch {
				return;
			}
			if (!message || typeof message !== "object" || !("type" in message)) return;
			if (message.type === "audio.delta" && "delta" in message && typeof message.delta === "string") try {
				const decoded = atob(message.delta);
				const chunk = new Uint8Array(decoded.length);
				for (let i = 0; i < decoded.length; i++) chunk[i] = decoded.charCodeAt(i);
				const pcm = normalizer.push(chunk);
				if (pcm) frames.push(pcm);
			} catch (error) {
				frames.fail(error instanceof Error ? error : /* @__PURE__ */ new Error("Workers AI Grok MP3 decode failed"));
			}
			else if (message.type === "audio.done") frames.finish();
			else if (message.type === "error") {
				const detail = "message" in message && typeof message.message === "string" ? `: ${message.message}` : "";
				frames.fail(/* @__PURE__ */ new Error(`Workers AI Grok TTS error${detail}`));
			}
		});
		ws.addEventListener("close", (event) => {
			frames.fail(/* @__PURE__ */ new Error(`Workers AI Grok TTS socket closed before audio.done (code ${event.code}${event.reason ? `: ${event.reason}` : ""})`));
		});
		ws.addEventListener("error", () => {
			frames.fail(/* @__PURE__ */ new Error("Workers AI Grok TTS socket error"));
		});
		const abort = () => {
			try {
				ws.send(JSON.stringify({ type: "text.clear" }));
			} catch {}
			frames.finish();
			try {
				ws.close();
			} catch {}
		};
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
		const inputPromise = (async () => {
			const reader = text.getReader();
			let sentText = false;
			try {
				while (!signal?.aborted) {
					const { done, value } = await reader.read();
					if (done) break;
					if (!value) continue;
					sentText = true;
					ws.send(JSON.stringify({
						type: "text.delta",
						delta: value
					}));
				}
				if (signal?.aborted) return;
				if (sentText) ws.send(JSON.stringify({ type: "text.done" }));
				else frames.finish();
			} finally {
				reader.releaseLock();
			}
		})().catch((error) => {
			if (signal?.aborted) return;
			frames.fail(error instanceof Error ? error : /* @__PURE__ */ new Error("Workers AI Grok TTS input stream failed"));
		});
		try {
			let nextYieldAt = 0;
			for await (const frame of frames) {
				if (signal?.aborted) return;
				const now = Date.now();
				if (nextYieldAt === 0) nextYieldAt = now + FRAME_MS;
				else {
					if (now < nextYieldAt) await new Promise((resolve) => setTimeout(resolve, nextYieldAt - now));
					nextYieldAt = Math.max(nextYieldAt + FRAME_MS, Date.now() + FRAME_MS);
				}
				yield frame;
			}
			await inputPromise;
		} finally {
			signal?.removeEventListener("abort", abort);
			try {
				ws.close();
			} catch {}
		}
	}
	async #open() {
		if (!this.#ai.fetch) throw new Error("Workers AI Grok TTS requires the native AI binding");
		const model = "xai/grok-tts";
		const endpoint = new URL("https://workers-binding.ai/run");
		endpoint.searchParams.set("model", model);
		endpoint.searchParams.set("language", this.#language);
		endpoint.searchParams.set("voice_id", this.#voice);
		endpoint.searchParams.set("websocket", "true");
		endpoint.searchParams.set("output_format.codec", "mp3");
		endpoint.searchParams.set("output_format.sample_rate", String(this.sampleRate));
		endpoint.searchParams.set("optimize_streaming_latency", String(this.#optimizeStreamingLatency));
		const response = await this.#ai.fetch(endpoint, { headers: {
			Upgrade: "websocket",
			"cf-aig-gateway-id": "default",
			"cf-consn-sdk-version": "2.0.0",
			"cf-consn-model-id": model
		} });
		const socket = "webSocket" in response && isWebSocket(response.webSocket) ? response.webSocket : null;
		if (!socket) {
			const body = await response.text().catch(() => "");
			throw new Error(`Workers AI Grok TTS WebSocket failed: HTTP ${response.status}${body ? ` — ${body.slice(0, 200)}` : ""}`);
		}
		socket.accept();
		socket.binaryType = "arraybuffer";
		return socket;
	}
};
const FRAME_MS = 20;
/**
* Bridges the TTS socket's arbitrary fragments into fixed-duration audio
* frames, with any complete-sample remainder emitted on `Flushed`.
*/
var AudioFrameStream = class {
	#frame;
	#frameLength = 0;
	#queue = [];
	#done = false;
	#error = null;
	#wake = null;
	constructor(frameBytes, sampleBytes) {
		this.frameBytes = frameBytes;
		this.sampleBytes = sampleBytes;
		this.#frame = new Uint8Array(frameBytes);
	}
	push(chunk) {
		if (this.#done) return;
		let offset = 0;
		while (offset < chunk.byteLength) {
			const copied = Math.min(this.frameBytes - this.#frameLength, chunk.byteLength - offset);
			this.#frame.set(chunk.subarray(offset, offset + copied), this.#frameLength);
			this.#frameLength += copied;
			offset += copied;
			if (this.#frameLength === this.frameBytes) {
				this.#queue.push(this.#frame.buffer);
				this.#frame = new Uint8Array(this.frameBytes);
				this.#frameLength = 0;
			}
		}
		this.#notify();
	}
	/** Server acknowledged the flush: emit the partial frame and end. */
	finish() {
		if (this.#done) return;
		if (this.#frameLength % this.sampleBytes !== 0) {
			this.fail(/* @__PURE__ */ new Error("Workers AI realtime TTS returned incomplete linear16 sample"));
			return;
		}
		if (this.#frameLength > 0) {
			this.#queue.push(this.#frame.slice(0, this.#frameLength).buffer);
			this.#frameLength = 0;
		}
		this.#done = true;
		this.#notify();
	}
	/** Socket died before the flush was acknowledged. No-op once ended. */
	fail(error) {
		if (this.#done) return;
		this.#error = error;
		this.#done = true;
		this.#notify();
	}
	#notify() {
		const wake = this.#wake;
		this.#wake = null;
		wake?.();
	}
	async *[Symbol.asyncIterator]() {
		while (true) {
			while (this.#queue.length > 0) yield this.#queue.shift();
			if (this.#error) throw this.#error;
			if (this.#done) return;
			await new Promise((resolve) => {
				this.#wake = resolve;
			});
		}
	}
};
function isWebSocket(value) {
	return !!value && typeof value === "object" && "accept" in value && typeof value.accept === "function" && "send" in value && typeof value.send === "function" && "addEventListener" in value && typeof value.addEventListener === "function";
}
/**
* Workers AI continuous speech-to-text provider using the Flux model.
*
* Flux is a conversational STT model with built-in end-of-turn detection.
* A single session is created per call and receives all audio continuously.
* The model detects speech boundaries and fires `onUtterance` when a
* turn is complete — no client-side silence detection needed for STT.
*
* Recommended for `withVoice` (conversational voice agents).
*
* @example
* ```ts
* import { Agent } from "agents";
* import { withVoice, WorkersAIFluxSTT, WorkersAITTS } from "@cloudflare/voice";
*
* const VoiceAgent = withVoice(Agent);
*
* class MyAgent extends VoiceAgent<Env> {
*   transcriber = new WorkersAIFluxSTT(this.env.AI);
*   tts = new WorkersAITTS(this.env.AI);
*
*   async onTurn(transcript, context) { ... }
* }
* ```
*/
var WorkersAIFluxSTT = class {
	#ai;
	#sampleRate;
	#eotThreshold;
	#eagerEotThreshold;
	#eotTimeoutMs;
	#keyterms;
	constructor(ai, options) {
		this.#ai = ai;
		this.#sampleRate = options?.sampleRate ?? 16e3;
		this.#eotThreshold = options?.eotThreshold;
		this.#eagerEotThreshold = options?.eagerEotThreshold;
		this.#eotTimeoutMs = options?.eotTimeoutMs;
		this.#keyterms = options?.keyterms;
	}
	createSession(options) {
		return new FluxSession(this.#ai, {
			sampleRate: this.#sampleRate,
			eotThreshold: this.#eotThreshold,
			eagerEotThreshold: this.#eagerEotThreshold,
			eotTimeoutMs: this.#eotTimeoutMs,
			keyterms: this.#keyterms
		}, options);
	}
};
/**
* Per-call Flux transcription session. Lives for the entire call.
*
* Handles multi-turn conversations: on EndOfTurn, fires onUtterance
* and resets transcript state for the next turn. On StartOfTurn,
* clears accumulated text. The session stays alive across turns
* and is only closed on end_call or disconnect.
*/
var FluxSession = class {
	#onInterim;
	#onSpeechStart;
	#onUtterance;
	#onEagerUtterance;
	#onTurnResumed;
	#ai;
	#config;
	#ws = null;
	#connected = false;
	#closed = false;
	#pendingChunks = [];
	#currentTranscript = "";
	#ready;
	#resolveReady = null;
	#rejectReady = null;
	constructor(ai, config, options) {
		this.#ai = ai;
		this.#config = config;
		this.#onInterim = options?.onInterim;
		this.#onSpeechStart = options?.onSpeechStart;
		this.#onUtterance = options?.onUtterance;
		this.#onEagerUtterance = options?.onEagerUtterance;
		this.#onTurnResumed = options?.onTurnResumed;
		this.#ready = new Promise((resolve, reject) => {
			this.#resolveReady = resolve;
			this.#rejectReady = reject;
		});
		this.#ready.catch(() => {});
		this.#connect();
	}
	waitUntilReady() {
		return this.#ready;
	}
	async #connect() {
		try {
			const input = {
				encoding: "linear16",
				sample_rate: String(this.#config.sampleRate)
			};
			if (this.#config.eotThreshold != null) input.eot_threshold = String(this.#config.eotThreshold);
			if (this.#config.eagerEotThreshold != null) input.eager_eot_threshold = String(this.#config.eagerEotThreshold);
			if (this.#config.eotTimeoutMs != null) input.eot_timeout_ms = String(this.#config.eotTimeoutMs);
			if (this.#config.keyterms?.length) input.keyterm = this.#config.keyterms;
			const resp = await this.#ai.run("@cf/deepgram/flux", input, { websocket: true });
			if (this.#closed) {
				const ws = resp.webSocket;
				if (ws) {
					ws.accept();
					ws.close();
				}
				this.#resolveReadiness();
				return;
			}
			const ws = resp.webSocket;
			if (!ws) {
				let message = "Workers AI Flux STT did not return a WebSocket";
				if (resp instanceof Response) {
					const body = await resp.text().catch(() => "");
					message = `Workers AI Flux STT failed: HTTP ${resp.status}${body ? ` — ${body.slice(0, 500)}` : ""}`;
				}
				const error = new Error(message);
				console.error("[FluxSTT] Failed to establish WebSocket:", error);
				this.#rejectReadiness(error);
				return;
			}
			ws.accept();
			this.#ws = ws;
			this.#connected = true;
			ws.addEventListener("message", (event) => {
				this.#handleMessage(event);
			});
			const reconnect = () => {
				if (this.#closed || this.#ws !== ws) return;
				this.#connected = false;
				this.#ws = null;
				this.#currentTranscript = "";
				this.#connect();
			};
			ws.addEventListener("close", reconnect);
			ws.addEventListener("error", (event) => {
				console.error("[FluxSTT] WebSocket error:", event);
				reconnect();
			});
			for (const chunk of this.#pendingChunks) ws.send(chunk);
			this.#pendingChunks = [];
			this.#resolveReadiness();
		} catch (err) {
			console.error("[FluxSTT] Connection error:", err);
			this.#rejectReadiness(err);
		}
	}
	feed(chunk) {
		if (this.#closed) return;
		if (this.#connected && this.#ws) this.#ws.send(chunk);
		else this.#pendingChunks.push(chunk);
	}
	close() {
		if (this.#closed) return;
		this.#closed = true;
		this.#pendingChunks = [];
		if (this.#ws) {
			try {
				this.#ws.close();
			} catch {}
			this.#ws = null;
		}
		this.#connected = false;
		this.#resolveReadiness();
	}
	#resolveReadiness() {
		const resolve = this.#resolveReady;
		if (!resolve) return;
		this.#resolveReady = null;
		this.#rejectReady = null;
		resolve();
	}
	#rejectReadiness(reason) {
		const reject = this.#rejectReady;
		if (!reject) return;
		this.#resolveReady = null;
		this.#rejectReady = null;
		reject(reason);
	}
	#handleMessage(event) {
		if (this.#closed) return;
		try {
			const data = typeof event.data === "string" ? JSON.parse(event.data) : null;
			if (!data || !data.event) return;
			const transcript = data.transcript ?? "";
			switch (data.event) {
				case "StartOfTurn":
					this.#currentTranscript = "";
					this.#onSpeechStart?.(transcript || void 0);
					if (transcript) {
						this.#currentTranscript = transcript;
						this.#onInterim?.(transcript);
					}
					break;
				case "Update":
					if (transcript) {
						this.#currentTranscript = transcript;
						this.#onInterim?.(transcript);
					}
					break;
				case "EndOfTurn": {
					const finalTranscript = transcript || this.#currentTranscript;
					this.#currentTranscript = "";
					if (finalTranscript) this.#onUtterance?.(finalTranscript);
					break;
				}
				case "EagerEndOfTurn":
					if (transcript) {
						this.#currentTranscript = transcript;
						this.#onInterim?.(transcript);
						this.#onEagerUtterance?.(transcript);
					}
					break;
				case "TurnResumed":
					this.#currentTranscript = transcript;
					if (transcript) this.#onInterim?.(transcript);
					this.#onTurnResumed?.(transcript || void 0);
					break;
			}
		} catch {}
	}
};
/**
* Workers AI continuous speech-to-text provider using Nova 3.
*
* Nova 3 is a high-accuracy STT model with streaming WebSocket support.
* A single session is created per call and receives all audio continuously.
* Server-side VAD events and endpointing handle speech boundary detection.
*
* Recommended for `withVoiceInput` (dictation / voice input UIs).
*
* @example
* ```ts
* import { Agent } from "agents";
* import { withVoiceInput, WorkersAINova3STT } from "@cloudflare/voice";
*
* const InputAgent = withVoiceInput(Agent);
*
* class MyAgent extends InputAgent<Env> {
*   transcriber = new WorkersAINova3STT(this.env.AI);
*
*   onTranscript(text, connection) { ... }
* }
* ```
*/
var WorkersAINova3STT = class {
	#ai;
	#sampleRate;
	#language;
	#endpointingMs;
	#utteranceEndMs;
	#smartFormat;
	#punctuate;
	#keyterms;
	constructor(ai, options) {
		this.#ai = ai;
		this.#sampleRate = options?.sampleRate ?? 16e3;
		this.#language = options?.language ?? "en";
		this.#endpointingMs = options?.endpointingMs ?? 300;
		this.#utteranceEndMs = options?.utteranceEndMs ?? 1e3;
		this.#smartFormat = options?.smartFormat ?? true;
		this.#punctuate = options?.punctuate ?? true;
		this.#keyterms = options?.keyterms;
	}
	createSession(options) {
		return new Nova3Session(this.#ai, {
			sampleRate: this.#sampleRate,
			language: this.#language,
			endpointingMs: this.#endpointingMs,
			utteranceEndMs: this.#utteranceEndMs,
			smartFormat: this.#smartFormat,
			punctuate: this.#punctuate,
			keyterms: this.#keyterms
		}, options);
	}
};
/**
* Per-call Nova 3 transcription session. Lives for the entire call.
*
* Uses Nova 3's endpointing and VAD events to detect utterance
* boundaries. When a result arrives with `speech_final: true`,
* the accumulated finalized segments are emitted as an utterance.
*/
var Nova3Session = class {
	#onSpeechStart;
	#onInterim;
	#onUtterance;
	#ws = null;
	#connected = false;
	#closed = false;
	#speechStartPending = false;
	#pendingChunks = [];
	#finalizedSegments = [];
	constructor(ai, config, options) {
		this.#onSpeechStart = options?.onSpeechStart;
		this.#onInterim = options?.onInterim;
		this.#onUtterance = options?.onUtterance;
		this.#connect(ai, config);
	}
	async #connect(ai, config) {
		try {
			const input = {
				encoding: "linear16",
				sample_rate: String(config.sampleRate),
				language: config.language,
				interim_results: "true",
				vad_events: "true",
				endpointing: String(config.endpointingMs),
				utterance_end_ms: String(config.utteranceEndMs),
				smart_format: String(config.smartFormat),
				punctuate: String(config.punctuate)
			};
			if (config.keyterms?.length) input.keyterm = config.keyterms;
			const resp = await ai.run("@cf/deepgram/nova-3", input, { websocket: true });
			if (this.#closed) {
				const ws = resp.webSocket;
				if (ws) {
					ws.accept();
					ws.close();
				}
				return;
			}
			const ws = resp.webSocket;
			if (!ws) {
				console.error("[Nova3STT] Failed to establish WebSocket connection");
				return;
			}
			ws.accept();
			this.#ws = ws;
			this.#connected = true;
			ws.addEventListener("message", (event) => {
				this.#handleMessage(event);
			});
			ws.addEventListener("close", () => {
				this.#connected = false;
			});
			ws.addEventListener("error", (event) => {
				console.error("[Nova3STT] WebSocket error:", event);
				this.#connected = false;
			});
			for (const chunk of this.#pendingChunks) ws.send(chunk);
			this.#pendingChunks = [];
		} catch (err) {
			console.error("[Nova3STT] Connection error:", err);
		}
	}
	feed(chunk) {
		if (this.#closed) return;
		if (this.#connected && this.#ws) this.#ws.send(chunk);
		else this.#pendingChunks.push(chunk);
	}
	close() {
		if (this.#closed) return;
		this.#closed = true;
		this.#pendingChunks = [];
		if (this.#ws) {
			try {
				this.#ws.close();
			} catch {}
			this.#ws = null;
		}
		this.#connected = false;
	}
	#handleMessage(event) {
		if (this.#closed) return;
		try {
			const data = typeof event.data === "string" ? JSON.parse(event.data) : null;
			if (!data) return;
			if (data.type === "SpeechStarted") {
				this.#speechStartPending = true;
				return;
			}
			if (data.type === "Results") {
				if (!this.#finalizedSegments) this.#finalizedSegments = [];
				const transcript = data.channel?.alternatives?.[0]?.transcript ?? "";
				if (this.#speechStartPending && transcript) {
					this.#speechStartPending = false;
					this.#onSpeechStart?.(transcript);
				}
				if (data.is_final && transcript) this.#finalizedSegments.push(transcript);
				if (data.speech_final) {
					this.#speechStartPending = false;
					const fullTranscript = (this.#finalizedSegments ?? []).join(" ").trim();
					this.#finalizedSegments = [];
					if (fullTranscript) this.#onUtterance?.(fullTranscript);
				} else if (!data.is_final && transcript) {
					const finalizedSegments = this.#finalizedSegments ?? [];
					const display = finalizedSegments.length > 0 ? finalizedSegments.join(" ") + " " + transcript : transcript;
					this.#onInterim?.(display);
				}
			}
		} catch {}
	}
};
//#endregion
//#region src/voice.ts
const DEFAULT_HISTORY_LIMIT = 20;
const DEFAULT_MAX_MESSAGE_COUNT = 1e3;
const DEFAULT_SAMPLE_RATE = 16e3;
const STREAMING_TTS_MAX_CHARS = 48;
function isEchoOf(transcript, assistantText) {
	if (!assistantText) return false;
	const assistant = assistantText.toLowerCase().match(/[\p{L}\p{N}]+/gu)?.join(" ") ?? "";
	const heard = transcript.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
	if (heard.length >= 3 && assistant.includes(heard.join(" "))) return true;
	const assistantWords = new Set(assistant.split(" "));
	const hits = heard.filter((word) => assistantWords.has(word)).length;
	return hits >= 4 && hits / heard.length >= .6;
}
/**
* Voice pipeline mixin. Adds the full voice pipeline to an Agent class.
*
* Subclasses must set a `transcriber` property (or override `createTranscriber`)
* and a `tts` provider property. The transcriber session is per-call — created
* at start_call and closed at end_call. The model handles turn detection.
*
* @param Base - The Agent class to extend (e.g. `Agent`).
* @param voiceOptions - Optional pipeline configuration.
*
* @example
* ```typescript
* import { Agent } from "agents";
* import { withVoice, WorkersAIFluxSTT, WorkersAITTS } from "@cloudflare/voice";
*
* const VoiceAgent = withVoice(Agent);
*
* class MyAgent extends VoiceAgent<Env> {
*   transcriber = new WorkersAIFluxSTT(this.env.AI);
*   tts = new WorkersAITTS(this.env.AI);
*
*   async onTurn(transcript, context) {
*     return "Hello! I heard you say: " + transcript;
*   }
* }
* ```
*/
function withVoice(Base, voiceOptions) {
	const opts = voiceOptions ?? {};
	function opt(key, fallback) {
		return opts[key] ?? fallback;
	}
	class VoiceAgentMixin extends Base {
		#cm = new AudioConnectionManager("VoiceAgent");
		#keepAliveDispose = /* @__PURE__ */ new Map();
		#audioTransports = /* @__PURE__ */ new Map();
		#conversationHistory = [];
		#speculativeTurns = /* @__PURE__ */ new Map();
		#activeAssistantText = /* @__PURE__ */ new Map();
		#callStartInputSuppressed = /* @__PURE__ */ new Set();
		#startupTokens = /* @__PURE__ */ new Map();
		static #VOICE_MESSAGES = /* @__PURE__ */ new Set([
			"hello",
			"start_call",
			"end_call",
			"start_of_speech",
			"end_of_speech",
			"interrupt",
			"text_message"
		]);
		#schemaReady = false;
		#ensureMessageSchema() {
			if (this.#schemaReady) return;
			this.sql`
        CREATE TABLE IF NOT EXISTS cf_voice_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          role TEXT NOT NULL,
          text TEXT NOT NULL,
          timestamp INTEGER NOT NULL
        )
      `;
			this.#schemaReady = true;
		}
		constructor(...args) {
			super(...args);
			const _onConnect = this.onConnect?.bind(this);
			const _onClose = this.onClose?.bind(this);
			const _onMessage = this.onMessage?.bind(this);
			this.onConnect = (connection, ...rest) => {
				this.#sendJSON(connection, {
					type: "welcome",
					protocol_version: 1
				});
				this.#sendJSON(connection, {
					type: "status",
					status: "idle"
				});
				return _onConnect?.(connection, ...rest);
			};
			this.onClose = (connection, ...rest) => {
				this.#startupTokens.delete(connection.id);
				this.#callStartInputSuppressed.delete(connection.id);
				this.#releaseKeepAlive(connection.id);
				this.#cm.cleanup(connection.id);
				const transport = this.#audioTransports.get(connection.id);
				if (transport) {
					this.#audioTransports.delete(connection.id);
					runBackground("audio_transport_stop", () => transport.stop(connection.id));
				}
				this.#cancelSpeculativeTurn(connection.id, "connection_closed");
				return _onClose?.(connection, ...rest);
			};
			this.onMessage = (connection, message) => {
				if (message instanceof ArrayBuffer) {
					this.receiveAudio(connection.id, message);
					return;
				}
				if (typeof message !== "string") return _onMessage?.(connection, message);
				let parsed;
				let messageType;
				try {
					const value = JSON.parse(message);
					if (!value || typeof value !== "object" || !("type" in value) || typeof value.type !== "string") return _onMessage?.(connection, message);
					parsed = value;
					messageType = value.type;
				} catch {
					return _onMessage?.(connection, message);
				}
				if (VoiceAgentMixin.#VOICE_MESSAGES.has(messageType)) {
					switch (messageType) {
						case "hello": break;
						case "start_call": {
							const preferredFormat = "preferred_format" in parsed && typeof parsed.preferred_format === "string" ? parsed.preferred_format : void 0;
							runBackground("start_call", () => this.#handleStartCall(connection, preferredFormat));
							break;
						}
						case "end_call":
							runBackground("end_call", () => this.#handleEndCall(connection));
							break;
						case "start_of_speech":
						case "end_of_speech": break;
						case "interrupt": {
							const source = "source" in parsed && parsed.source === "audio_level" ? "client_audio_level" : "client_interrupt";
							runBackground("interrupt", () => this.#handleInterrupt(connection, source));
							break;
						}
						case "text_message": {
							const text = "text" in parsed ? parsed.text : void 0;
							if (typeof text === "string") runBackground("text_message", () => this.#handleTextMessage(connection, text));
							break;
						}
					}
					return;
				}
				return _onMessage?.(connection, message);
			};
		}
		onTurn(_transcript, _context) {
			throw new Error("VoiceAgent subclass must implement onTurn(). Return a string, AI SDK stream, AsyncIterable<string>, or ReadableStream.");
		}
		/**
		* Override to create a transcriber dynamically per connection.
		* Useful for runtime model switching (e.g. Flux vs Nova 3 dropdown).
		* Return null to fall back to the `transcriber` property.
		*/
		createTranscriber(_connection) {
			return null;
		}
		createAudioTransport(_connection) {
			return null;
		}
		receiveAudio(connectionId, audio) {
			if (this.#callStartInputSuppressed.has(connectionId)) return;
			this.#cm.bufferAudio(connectionId, audio);
		}
		beforeCallStart(_connection) {
			return true;
		}
		onCallStart(_connection) {}
		onCallEnd(_connection) {}
		onInterrupt(_connection) {}
		afterTranscribe(transcript, connection) {
			return opt("filterEchoedTranscripts", false) && this.#isEchoTranscript(connection.id, transcript) ? null : transcript;
		}
		#isEchoTranscript(connectionId, transcript) {
			const active = this.#activeAssistantText.get(connectionId);
			if (active && isEchoOf(transcript, active.text)) return true;
			const history = this.getConversationHistory();
			for (let i = history.length - 1; i >= 0; i--) if (history[i].role === "assistant") return isEchoOf(transcript, history[i].content);
			return false;
		}
		beforeSynthesize(text, _connection) {
			return text;
		}
		afterSynthesize(audio, _text, _connection) {
			return audio;
		}
		saveMessage(role, text) {
			const maxMessages = opt("maxMessageCount", DEFAULT_MAX_MESSAGE_COUNT);
			if (!opt("persistMessages", false)) {
				this.#conversationHistory.push({
					role,
					content: text
				});
				const excess = this.#conversationHistory.length - maxMessages;
				if (excess > 0) this.#conversationHistory.splice(0, excess);
				return;
			}
			this.#ensureMessageSchema();
			this.sql`
        INSERT INTO cf_voice_messages (role, text, timestamp)
        VALUES (${role}, ${text}, ${Date.now()})
      `;
			this.sql`
        DELETE FROM cf_voice_messages
        WHERE id NOT IN (
          SELECT id FROM cf_voice_messages
          ORDER BY id DESC LIMIT ${maxMessages}
        )
      `;
		}
		getConversationHistory(limit) {
			const historyLimit = limit ?? opt("historyLimit", DEFAULT_HISTORY_LIMIT);
			if (historyLimit <= 0) return [];
			if (!opt("persistMessages", false)) return this.#conversationHistory.slice(-historyLimit).map((message) => ({ ...message }));
			this.#ensureMessageSchema();
			return this.sql`
        SELECT role, text FROM cf_voice_messages
        ORDER BY id DESC LIMIT ${historyLimit}
      `.reverse().map((row) => ({
				role: row.role,
				content: row.text
			}));
		}
		async #sendAudio(connection, audio) {
			const transport = this.#audioTransports.get(connection.id);
			if (transport) await transport.send(connection.id, audio);
			else connection.send(audio);
		}
		async #flushAudio(connection) {
			await this.#audioTransports.get(connection.id)?.flush(connection.id);
		}
		async #stopAudioTransport(connectionId) {
			const transport = this.#audioTransports.get(connectionId);
			if (!transport) return;
			this.#audioTransports.delete(connectionId);
			await transport.stop(connectionId);
		}
		#cancelSpeculativeTurn(connectionId, reason) {
			const turn = this.#speculativeTurns.get(connectionId);
			if (!turn) return null;
			this.#speculativeTurns.delete(connectionId);
			console.log("[VoiceTrace]", {
				event: "speculative_turn_cancelled",
				connectionId,
				elapsedMs: Date.now() - turn.startedAt,
				reason
			});
			turn.settle(false);
			return turn;
		}
		#startSpeculativeTurn(connection, transcript) {
			if (this.#speculativeTurns.has(connection.id)) return;
			let settle = () => {};
			const outcome = new Promise((resolve) => {
				settle = resolve;
			});
			const turn = {
				provisionalTranscript: transcript.trim(),
				startedAt: Date.now(),
				outcome,
				settle,
				pipelineStarted: false
			};
			this.#speculativeTurns.set(connection.id, turn);
			console.log("[VoiceTrace]", {
				event: "speculative_turn_started",
				connectionId: connection.id,
				elapsedMs: Date.now() - turn.startedAt
			});
			this.#runPipeline(connection, transcript, turn);
		}
		forceEndCall(connection) {
			if (!this.#cm.isInCall(connection.id)) return;
			runBackground("force_end_call", () => this.#handleEndCall(connection));
		}
		async speak(connection, text) {
			const signal = this.#cm.createPipelineAbort(connection.id);
			try {
				this.#sendJSON(connection, {
					type: "status",
					status: "speaking"
				});
				this.#sendJSON(connection, {
					type: "transcript_start",
					role: "assistant"
				});
				this.#sendJSON(connection, {
					type: "transcript_end",
					text
				});
				await this.#speakText(connection, text, signal);
				if (!signal.aborted) {
					this.#cm.updateAgentContext(connection.id, text);
					this.saveMessage("assistant", text);
					this.#sendJSON(connection, {
						type: "status",
						status: "listening"
					});
				}
			} finally {
				this.#cm.clearPipelineAbort(connection.id, signal);
			}
		}
		async speakAll(text) {
			this.saveMessage("assistant", text);
			const connections = [...this.getConnections()];
			if (connections.length === 0) return;
			for (const connection of connections) {
				const signal = this.#cm.createPipelineAbort(connection.id);
				try {
					this.#sendJSON(connection, {
						type: "status",
						status: "speaking"
					});
					this.#sendJSON(connection, {
						type: "transcript_start",
						role: "assistant"
					});
					this.#sendJSON(connection, {
						type: "transcript_end",
						text
					});
					await this.#speakText(connection, text, signal);
					if (!signal.aborted) {
						this.#cm.updateAgentContext(connection.id, text);
						this.#sendJSON(connection, {
							type: "status",
							status: "listening"
						});
					}
				} finally {
					this.#cm.clearPipelineAbort(connection.id, signal);
				}
			}
		}
		#requireTTS() {
			if (!this.tts) throw new Error("No TTS provider configured. Set 'tts' on your VoiceAgent subclass.");
			return this.tts;
		}
		async #synthesizeWithHooks(text, connection, signal) {
			const textToSpeak = await this.beforeSynthesize(text, connection);
			if (!textToSpeak) return null;
			const rawAudio = await this.#requireTTS().synthesize(textToSpeak, signal);
			return this.afterSynthesize(rawAudio, textToSpeak, connection);
		}
		async #speakText(connection, text, signal) {
			const tts = this.#requireTTS();
			if (typeof tts.synthesizeStream === "function") {
				const textToSpeak = await this.beforeSynthesize(text, connection);
				if (!textToSpeak || signal.aborted) return;
				for await (const chunk of tts.synthesizeStream(textToSpeak, signal)) {
					if (signal.aborted) return;
					const processed = await this.afterSynthesize(chunk, textToSpeak, connection);
					if (processed) await this.#sendAudio(connection, processed);
				}
				if (!signal.aborted) await this.#flushAudio(connection);
				return;
			}
			const audio = await this.#synthesizeWithHooks(text, connection, signal);
			if (audio && !signal.aborted) await this.#sendAudio(connection, audio);
			if (!signal.aborted) await this.#flushAudio(connection);
		}
		async #handleStartCall(connection, _preferredFormat) {
			if (this.#cm.isInCall(connection.id)) return;
			const startupToken = Symbol(connection.id);
			this.#startupTokens.set(connection.id, startupToken);
			this.#cm.initConnection(connection.id);
			let provider;
			try {
				const allowed = await this.beforeCallStart(connection);
				if (!this.#isCurrentStartup(connection.id, startupToken)) return;
				if (!allowed) {
					await this.#handleStartupFailure(connection, startupToken, void 0, "Voice call was rejected", null);
					return;
				}
				const dispose = await this.keepAlive();
				if (!this.#isCurrentStartup(connection.id, startupToken)) {
					dispose();
					return;
				}
				this.#keepAliveDispose.set(connection.id, dispose);
				const configuredFormat = opts.audioFormat ?? this.tts?.audioFormat ?? "mp3";
				const configuredSampleRate = opts.sampleRate ?? this.tts?.sampleRate ?? DEFAULT_SAMPLE_RATE;
				this.#sendJSON(connection, {
					type: "audio_config",
					format: configuredFormat,
					sampleRate: configuredSampleRate
				});
				const transport = await this.createAudioTransport(connection);
				if (transport) {
					this.#audioTransports.set(connection.id, transport);
					await transport.start(connection.id, (audio) => this.receiveAudio(connection.id, audio));
					if (!this.#isCurrentStartup(connection.id, startupToken)) return;
				}
				if (!this.#isCurrentStartup(connection.id, startupToken)) return;
				provider = this.createTranscriber(connection) ?? this.transcriber;
				if (!provider) {
					const message = "No transcriber configured. Set 'transcriber' on your VoiceAgent subclass or override createTranscriber().";
					console.error(`[VoiceAgent] ${message}`);
					await this.#handleStartupFailure(connection, startupToken, void 0, message, null);
					return;
				}
			} catch (error) {
				await this.#handleStartupFailure(connection, startupToken, error, "Voice call failed to start");
				return;
			}
			if (!provider) return;
			let session;
			try {
				session = this.#cm.startTranscriberSession(connection.id, provider, {
					onInterim: (text) => {
						this.#sendJSON(connection, {
							type: "transcript_interim",
							text
						});
					},
					onSpeechStart: (transcript) => {
						const echoed = opt("filterEchoedTranscripts", false) && Boolean(transcript && this.#isEchoTranscript(connection.id, transcript));
						console.log("[VoiceTrace]", {
							event: "stt_speech_start",
							connectionId: connection.id,
							transcript: transcript ?? null,
							echoed
						});
						if (echoed) return;
						this.#handleBargeIn(connection, "flux_speech_start", transcript);
					},
					onEagerUtterance: (transcript) => {
						const echoed = opt("filterEchoedTranscripts", false) && this.#isEchoTranscript(connection.id, transcript);
						console.log("[VoiceTrace]", {
							event: "stt_eager_utterance",
							connectionId: connection.id,
							transcript,
							echoed
						});
						if (echoed) return;
						if (opt("filterEchoedTranscripts", false)) this.#handleBargeIn(connection, "flux_eager_utterance", transcript);
						this.#startSpeculativeTurn(connection, transcript);
					},
					onTurnResumed: () => {
						if (this.#cancelSpeculativeTurn(connection.id, "turn_resumed")?.pipelineStarted) this.#cm.abortPipeline(connection.id);
					},
					onUtterance: (transcript) => {
						console.log("[VoiceTrace]", {
							event: "stt_utterance",
							connectionId: connection.id,
							text: transcript
						});
						this.#sendJSON(connection, {
							type: "transcript_interim",
							text: ""
						});
						const speculative = this.#speculativeTurns.get(connection.id);
						if (speculative) {
							const finalText = transcript.trim();
							if (finalText === speculative.provisionalTranscript) {
								this.#speculativeTurns.delete(connection.id);
								console.log("[VoiceTrace]", {
									event: "speculative_turn_confirmed",
									connectionId: connection.id,
									elapsedMs: Date.now() - speculative.startedAt
								});
								speculative.settle(true);
								return;
							}
							const eagerText = speculative.provisionalTranscript;
							const startedAt = speculative.startedAt;
							if (this.#cancelSpeculativeTurn(connection.id, "transcript_mismatch")?.pipelineStarted) this.#cm.abortPipeline(connection.id);
							console.log("[VoiceTrace]", {
								event: "speculative_turn_restarted",
								connectionId: connection.id,
								elapsedMs: Date.now() - startedAt,
								eagerText,
								finalText
							});
							this.#runPipeline(connection, transcript);
							return;
						}
						this.#runPipeline(connection, transcript);
					}
				});
				await session.waitUntilReady?.();
			} catch (error) {
				await this.#handleTranscriberStartupFailure(connection, startupToken, error);
				return;
			}
			if (!this.#isCurrentStartup(connection.id, startupToken)) return;
			this.#startupTokens.delete(connection.id);
			this.#sendJSON(connection, {
				type: "status",
				status: "listening"
			});
			if (!opt("listenDuringCallStart", true)) this.#callStartInputSuppressed.add(connection.id);
			try {
				await this.onCallStart(connection);
			} finally {
				this.#callStartInputSuppressed.delete(connection.id);
			}
		}
		#isCurrentStartup(connectionId, startupToken) {
			return this.#startupTokens.get(connectionId) === startupToken && this.#cm.isInCall(connectionId);
		}
		async #handleTranscriberStartupFailure(connection, startupToken, error) {
			const detail = error instanceof Error ? `: ${error.message}` : "";
			await this.#handleStartupFailure(connection, startupToken, error, `Speech recognition failed to start${detail}`, "[VoiceAgent] Transcriber startup failed:");
		}
		async #handleStartupFailure(connection, startupToken, error, clientMessage, logPrefix = "[VoiceAgent] Call startup failed:") {
			if (!this.#isCurrentStartup(connection.id, startupToken)) return;
			if (logPrefix && error !== void 0) console.error(logPrefix, error);
			this.#startupTokens.delete(connection.id);
			this.#sendJSON(connection, {
				type: "error",
				message: clientMessage
			});
			try {
				await this.#stopAudioTransport(connection.id);
			} finally {
				this.#cm.cleanup(connection.id);
				this.#releaseKeepAlive(connection.id);
				this.#sendJSON(connection, {
					type: "status",
					status: "idle"
				});
				await this.onCallEnd(connection);
			}
		}
		#releaseKeepAlive(connectionId) {
			const dispose = this.#keepAliveDispose.get(connectionId);
			if (dispose) {
				dispose();
				this.#keepAliveDispose.delete(connectionId);
			}
		}
		async #handleEndCall(connection) {
			this.#startupTokens.delete(connection.id);
			this.#cancelSpeculativeTurn(connection.id, "end_call");
			this.#cm.cleanup(connection.id);
			try {
				await this.#stopAudioTransport(connection.id);
			} finally {
				this.#releaseKeepAlive(connection.id);
				this.#sendJSON(connection, {
					type: "status",
					status: "idle"
				});
				await this.onCallEnd(connection);
			}
		}
		async #handleInterrupt(connection, trigger) {
			console.log("[VoiceTrace]", {
				event: "interrupt_trigger",
				connectionId: connection.id,
				trigger,
				transcript: null,
				activePipeline: this.#cm.hasActivePipeline(connection.id),
				action: "interrupt"
			});
			this.#cm.abortPipeline(connection.id);
			this.#cancelSpeculativeTurn(connection.id, "interrupt");
			this.#cm.clearAudioBuffer(connection.id);
			this.#sendJSON(connection, {
				type: "status",
				status: "listening"
			});
			try {
				await this.#audioTransports.get(connection.id)?.interrupt(connection.id);
			} finally {
				await this.onInterrupt(connection);
			}
		}
		#handleBargeIn(connection, trigger, transcript) {
			this.#cancelSpeculativeTurn(connection.id, "speech_start");
			const activePipeline = this.#cm.hasActivePipeline(connection.id);
			const interrupted = this.#cm.abortPipeline(connection.id);
			console.log("[VoiceTrace]", {
				event: "interrupt_trigger",
				connectionId: connection.id,
				trigger,
				transcript: transcript ?? null,
				activePipeline,
				action: interrupted ? "interrupt" : "no_active_pipeline"
			});
			if (!interrupted) return;
			this.#sendJSON(connection, { type: "playback_interrupt" });
			this.#sendJSON(connection, {
				type: "status",
				status: "listening"
			});
			runBackground("barge_in", async () => {
				try {
					await this.#audioTransports.get(connection.id)?.interrupt(connection.id);
				} finally {
					await this.onInterrupt(connection);
				}
			});
		}
		async #handleTextMessage(connection, text) {
			if (!text || text.trim().length === 0) return;
			const userText = text.trim();
			const signal = this.#cm.createPipelineAbort(connection.id);
			const pipelineStart = Date.now();
			this.#sendJSON(connection, {
				type: "status",
				status: "thinking"
			});
			const priorMessages = this.getConversationHistory();
			this.saveMessage("user", userText);
			this.#sendJSON(connection, {
				type: "transcript",
				role: "user",
				text: userText
			});
			try {
				const context = {
					connection,
					messages: priorMessages,
					signal
				};
				const llmStart = Date.now();
				const turnResult = await this.onTurn(userText, context);
				console.log("[VoiceTrace]", {
					event: "onTurn_call",
					connectionId: connection.id,
					text: userText,
					history: context.messages
				});
				if (signal.aborted) return;
				if (this.#cm.isInCall(connection.id)) {
					this.#sendJSON(connection, {
						type: "status",
						status: "speaking"
					});
					const { text: fullText } = await this.#streamResponse(connection, turnResult, llmStart, pipelineStart, signal);
					if (signal.aborted) return;
					if (fullText && fullText.trim().length > 0) {
						this.#cm.updateAgentContext(connection.id, fullText);
						this.saveMessage("assistant", fullText);
					}
					this.#sendJSON(connection, {
						type: "status",
						status: "listening"
					});
				} else {
					let fullText = "";
					let pendingText = "";
					let transcriptStarted = false;
					const sendAssistantDelta = (token) => {
						if (!transcriptStarted) {
							pendingText += token;
							if (pendingText.trim().length === 0) return;
							this.#sendJSON(connection, {
								type: "transcript_start",
								role: "assistant"
							});
							transcriptStarted = true;
							token = pendingText;
							pendingText = "";
						}
						this.#sendJSON(connection, {
							type: "transcript_delta",
							text: token
						});
					};
					for await (const token of iterateText(turnResult)) {
						if (signal.aborted) break;
						fullText += token;
						sendAssistantDelta(token);
					}
					if (fullText && fullText.trim().length > 0) {
						if (transcriptStarted) this.#sendJSON(connection, {
							type: "transcript_end",
							text: fullText
						});
						this.saveMessage("assistant", fullText);
					}
					this.#sendJSON(connection, {
						type: "status",
						status: "idle"
					});
				}
			} catch (error) {
				if (signal.aborted) return;
				console.error("[VoiceAgent] Text pipeline error:", error);
				this.#sendJSON(connection, {
					type: "error",
					message: error instanceof Error ? error.message : "Text pipeline failed"
				});
				this.#sendJSON(connection, {
					type: "status",
					status: this.#cm.isInCall(connection.id) ? "listening" : "idle"
				});
			} finally {
				this.#cm.clearPipelineAbort(connection.id, signal);
			}
		}
		async #runPipeline(connection, transcript, speculative) {
			let signal;
			const pipelineStart = Date.now();
			try {
				let userText;
				try {
					userText = await this.afterTranscribe(transcript, connection);
				} catch (error) {
					if (!speculative) throw error;
					if (!await speculative.outcome) return;
					throw error;
				}
				if (!userText) {
					if (speculative) {
						if (!await speculative.outcome) return;
					}
					if (!this.#cm.hasActivePipeline(connection.id)) this.#sendJSON(connection, {
						type: "status",
						status: "listening"
					});
					return;
				}
				if (!speculative && opt("filterEchoedTranscripts", false) && this.#cm.hasActivePipeline(connection.id)) this.#handleBargeIn(connection, "flux_confirmed_utterance", userText);
				signal = this.#cm.createPipelineAbort(connection.id);
				if (speculative) speculative.pipelineStarted = true;
				const priorMessages = this.getConversationHistory();
				if (!speculative) {
					this.saveMessage("user", userText);
					this.#sendJSON(connection, {
						type: "transcript",
						role: "user",
						text: userText
					});
					this.#sendJSON(connection, {
						type: "status",
						status: "thinking"
					});
				}
				const context = {
					connection,
					messages: priorMessages,
					signal
				};
				const llmStart = Date.now();
				const pendingTurnResult = Promise.resolve().then(() => this.onTurn(userText, context)).then((value) => ({
					ok: true,
					value
				}), (error) => ({
					ok: false,
					error
				}));
				if (speculative) {
					if (!await speculative.outcome) return;
					this.saveMessage("user", userText);
					this.#sendJSON(connection, {
						type: "transcript",
						role: "user",
						text: userText
					});
					if (signal.aborted) return;
					this.#sendJSON(connection, {
						type: "status",
						status: "thinking"
					});
				}
				const settledTurnResult = await pendingTurnResult;
				if (!settledTurnResult.ok) {
					if (signal.aborted) return;
					throw settledTurnResult.error;
				}
				const turnResult = settledTurnResult.value;
				console.log("[VoiceTrace]", {
					event: "onTurn_call",
					connectionId: connection.id,
					text: userText,
					history: context.messages
				});
				if (signal.aborted) return;
				this.#sendJSON(connection, {
					type: "status",
					status: "speaking"
				});
				const { text: fullText, llmMs, ttsMs, firstModelDeltaMs, firstSentenceMs, firstAudioMs } = await this.#streamResponse(connection, turnResult, llmStart, pipelineStart, signal);
				if (signal.aborted) return;
				if (!fullText || fullText.trim().length === 0) {
					console.log("[VoiceTrace]", {
						event: "turn_empty",
						connectionId: connection.id,
						llmMs,
						firstModelDeltaMs,
						totalMs: Date.now() - pipelineStart,
						reason: "model produced no text"
					});
					this.#sendJSON(connection, {
						type: "error",
						message: "No response generated"
					});
					this.#sendJSON(connection, {
						type: "status",
						status: "listening"
					});
					return;
				}
				const totalMs = Date.now() - pipelineStart;
				this.#sendJSON(connection, {
					type: "metrics",
					llm_ms: llmMs,
					tts_ms: ttsMs,
					first_model_delta_ms: firstModelDeltaMs,
					first_sentence_ms: firstSentenceMs,
					first_audio_ms: firstAudioMs,
					total_ms: totalMs
				});
				console.log("[VoiceTrace]", {
					event: "turn_complete",
					connectionId: connection.id,
					llmMs,
					ttsMs,
					firstModelDeltaMs,
					firstSentenceMs,
					firstAudioMs,
					totalMs,
					chars: fullText.length,
					text: fullText
				});
				this.#cm.updateAgentContext(connection.id, fullText);
				this.saveMessage("assistant", fullText);
				this.#sendJSON(connection, {
					type: "status",
					status: "listening"
				});
			} catch (error) {
				if (signal?.aborted) return;
				console.error("[VoiceAgent] Pipeline error:", error);
				this.#sendJSON(connection, {
					type: "error",
					message: error instanceof Error ? error.message : "Voice pipeline failed"
				});
				this.#sendJSON(connection, {
					type: "status",
					status: "listening"
				});
			} finally {
				if (signal && this.#activeAssistantText.get(connection.id)?.signal === signal) this.#activeAssistantText.delete(connection.id);
				if (signal) this.#cm.clearPipelineAbort(connection.id, signal);
			}
		}
		async #streamResponse(connection, response, llmStart, pipelineStart, signal) {
			if (typeof response === "string") {
				this.#activeAssistantText.set(connection.id, {
					signal,
					text: response
				});
				const llmMs = Date.now() - llmStart;
				if (response.trim().length === 0) return {
					text: response,
					llmMs,
					ttsMs: 0,
					firstModelDeltaMs: llmMs,
					firstSentenceMs: llmMs,
					firstAudioMs: 0
				};
				this.#sendJSON(connection, {
					type: "transcript_start",
					role: "assistant"
				});
				this.#sendJSON(connection, {
					type: "transcript_end",
					text: response
				});
				const ttsStart = Date.now();
				const audio = await this.#synthesizeWithHooks(response, connection);
				const ttsMs = Date.now() - ttsStart;
				if (audio && !signal.aborted) await this.#sendAudio(connection, audio);
				if (!signal.aborted) await this.#flushAudio(connection);
				return {
					text: response,
					llmMs,
					ttsMs,
					firstModelDeltaMs: llmMs,
					firstSentenceMs: llmMs,
					firstAudioMs: Date.now() - pipelineStart
				};
			}
			const tts = this.#requireTTS();
			const tokenStream = iterateTextEvents(response);
			if (typeof tts.synthesizeTextStream === "function") return this.#textStreamingTTSPipeline(connection, tokenStream, llmStart, pipelineStart, signal, tts);
			return this.#streamingTTSPipeline(connection, tokenStream, llmStart, pipelineStart, signal);
		}
		async #textStreamingTTSPipeline(connection, tokenStream, llmStart, pipelineStart, signal, tts) {
			const textStream = new TransformStream();
			const writer = textStream.writable.getWriter();
			let fullText = "";
			let pendingTranscriptText = "";
			let transcriptStarted = false;
			let firstModelDeltaAt = null;
			let firstAudioSentAt = null;
			const ttsStart = Date.now();
			const trace = (event, details = {}) => {
				console.log("[VoiceTrace]", {
					event,
					connectionId: connection.id,
					elapsedMs: Date.now() - pipelineStart,
					...details
				});
			};
			const sendAssistantDelta = (token) => {
				if (!transcriptStarted) {
					pendingTranscriptText += token;
					if (pendingTranscriptText.trim().length === 0) return;
					this.#sendJSON(connection, {
						type: "transcript_start",
						role: "assistant"
					});
					transcriptStarted = true;
					token = pendingTranscriptText;
					pendingTranscriptText = "";
				}
				this.#sendJSON(connection, {
					type: "transcript_delta",
					text: token
				});
			};
			const audioPromise = (async () => {
				for await (const chunk of tts.synthesizeTextStream(textStream.readable, signal)) {
					if (signal.aborted) return;
					await this.#sendAudio(connection, chunk);
					if (firstAudioSentAt === null) {
						firstAudioSentAt = Date.now();
						trace("tts_first_audio", { bytes: chunk.byteLength });
					}
				}
			})();
			try {
				for await (const event of tokenStream) {
					if (signal.aborted) break;
					if (event.type === "boundary") continue;
					if (event.type === "error") throw event.error;
					const token = event.text;
					if (firstModelDeltaAt === null) {
						firstModelDeltaAt = Date.now();
						trace("model_first_delta");
					}
					fullText += token;
					this.#activeAssistantText.set(connection.id, {
						signal,
						text: fullText
					});
					sendAssistantDelta(token);
					await writer.write(token);
				}
				if (signal.aborted) await writer.abort(signal.reason).catch(() => void 0);
				else await writer.close();
				await audioPromise;
			} catch (error) {
				await writer.abort(error).catch(() => void 0);
				await audioPromise.catch(() => void 0);
				throw error;
			}
			const llmMs = Date.now() - llmStart;
			trace("model_stream_complete", {
				generatedChars: fullText.length,
				aborted: signal.aborted,
				text: fullText
			});
			if (transcriptStarted) this.#sendJSON(connection, {
				type: "transcript_end",
				text: fullText
			});
			if (!signal.aborted) await this.#flushAudio(connection);
			const firstModelDeltaMs = firstModelDeltaAt ? firstModelDeltaAt - pipelineStart : 0;
			return {
				text: fullText,
				llmMs,
				ttsMs: Date.now() - ttsStart,
				firstModelDeltaMs,
				firstSentenceMs: firstModelDeltaMs,
				firstAudioMs: firstAudioSentAt ? firstAudioSentAt - pipelineStart : 0
			};
		}
		async #streamingTTSPipeline(connection, tokenStream, llmStart, pipelineStart, signal) {
			const tts = this.#requireTTS();
			const chunker = new SentenceChunker(typeof tts.synthesizeStream === "function" ? STREAMING_TTS_MAX_CHARS : Number.POSITIVE_INFINITY);
			const ttsQueue = [];
			let fullText = "";
			let pendingTranscriptText = "";
			let transcriptStarted = false;
			let firstAudioSentAt = null;
			let firstModelDeltaAt = null;
			let firstSentenceAt = null;
			let cumulativeTtsMs = 0;
			const trace = (event, details = {}) => {
				console.log("[VoiceTrace]", {
					event,
					connectionId: connection.id,
					elapsedMs: Date.now() - pipelineStart,
					...details
				});
			};
			let streamComplete = false;
			let drainNotify = null;
			let drainPending = false;
			let drainedCount = 0;
			const drainWaiters = /* @__PURE__ */ new Map();
			const notifyDrain = () => {
				if (drainNotify) {
					const resolve = drainNotify;
					drainNotify = null;
					resolve();
				} else drainPending = true;
			};
			const notifyDrained = () => {
				for (const [target, waiters] of drainWaiters) {
					if (drainedCount < target) continue;
					drainWaiters.delete(target);
					for (const resolve of waiters) resolve();
				}
			};
			const waitForDrained = (target) => {
				if (drainedCount >= target) return Promise.resolve();
				return new Promise((resolve) => {
					const waiters = drainWaiters.get(target) ?? [];
					waiters.push(resolve);
					drainWaiters.set(target, waiters);
				});
			};
			const drainPromise = (async () => {
				let i = 0;
				while (true) {
					while (i >= ttsQueue.length) {
						if (streamComplete && i >= ttsQueue.length) return;
						if (drainPending) {
							drainPending = false;
							continue;
						}
						await new Promise((r) => {
							drainNotify = r;
						});
						if (streamComplete && i >= ttsQueue.length) return;
					}
					if (signal.aborted) return;
					try {
						for await (const chunk of ttsQueue[i]) {
							if (signal.aborted) return;
							await this.#sendAudio(connection, chunk);
							if (!firstAudioSentAt) {
								firstAudioSentAt = Date.now();
								trace("tts_first_audio", { bytes: chunk.byteLength });
							}
						}
					} catch (err) {
						if (signal.aborted) return;
						console.error("[VoiceAgent] TTS error for sentence:", err);
						this.#sendJSON(connection, {
							type: "error",
							message: err instanceof Error ? err.message : "TTS failed for a sentence"
						});
					}
					i++;
					drainedCount = i;
					notifyDrained();
				}
			})();
			const makeSentenceTTS = (sentence) => {
				const self = this;
				async function* generate() {
					const ttsStart = Date.now();
					const text = await self.beforeSynthesize(sentence, connection);
					if (!text) return;
					if (typeof tts.synthesizeStream === "function") for await (const chunk of tts.synthesizeStream(text, signal)) {
						const processed = await self.afterSynthesize(chunk, text, connection);
						if (processed) yield processed;
					}
					else {
						const rawAudio = await tts.synthesize(text, signal);
						const processed = await self.afterSynthesize(rawAudio, text, connection);
						if (processed) yield processed;
					}
					const synthMs = Date.now() - ttsStart;
					cumulativeTtsMs += synthMs;
					trace("tts_sentence", {
						chars: text.length,
						synthMs,
						text
					});
				}
				return eagerAsyncIterable(generate());
			};
			const enqueueSentence = (sentence) => {
				firstSentenceAt ??= Date.now();
				ttsQueue.push(makeSentenceTTS(sentence));
				notifyDrain();
			};
			const sendAssistantDelta = (token) => {
				if (!transcriptStarted) {
					pendingTranscriptText += token;
					if (pendingTranscriptText.trim().length === 0) return;
					this.#sendJSON(connection, {
						type: "transcript_start",
						role: "assistant"
					});
					transcriptStarted = true;
					token = pendingTranscriptText;
					pendingTranscriptText = "";
				}
				this.#sendJSON(connection, {
					type: "transcript_delta",
					text: token
				});
			};
			for await (const event of tokenStream) {
				if (signal.aborted) break;
				if (event.type === "boundary") {
					for (const sentence of chunker.flush()) enqueueSentence(sentence);
					await waitForDrained(ttsQueue.length);
					continue;
				}
				if (event.type === "error") {
					trace("model_stream_error", {
						error: event.error instanceof Error ? event.error.message : String(event.error),
						generatedChars: fullText.length
					});
					for (const sentence of chunker.flush()) enqueueSentence(sentence);
					await waitForDrained(ttsQueue.length);
					if (transcriptStarted) this.#sendJSON(connection, {
						type: "transcript_end",
						text: fullText
					});
					streamComplete = true;
					notifyDrain();
					await drainPromise;
					throw event.error;
				}
				const token = event.text;
				if (firstModelDeltaAt === null) {
					firstModelDeltaAt = Date.now();
					trace("model_first_delta");
				}
				fullText += token;
				this.#activeAssistantText.set(connection.id, {
					signal,
					text: fullText
				});
				sendAssistantDelta(token);
				const sentences = chunker.add(token);
				for (const sentence of sentences) enqueueSentence(sentence);
			}
			const llmMs = Date.now() - llmStart;
			trace("model_stream_complete", {
				generatedChars: fullText.length,
				aborted: signal.aborted,
				text: fullText
			});
			const remaining = chunker.flush();
			for (const sentence of remaining) enqueueSentence(sentence);
			streamComplete = true;
			notifyDrain();
			if (transcriptStarted) this.#sendJSON(connection, {
				type: "transcript_end",
				text: fullText
			});
			await drainPromise;
			if (!signal.aborted) await this.#flushAudio(connection);
			const firstAudioMs = firstAudioSentAt ? firstAudioSentAt - pipelineStart : 0;
			const firstModelDeltaMs = firstModelDeltaAt ? firstModelDeltaAt - pipelineStart : 0;
			const firstSentenceMs = firstSentenceAt ? firstSentenceAt - pipelineStart : 0;
			return {
				text: fullText,
				llmMs,
				ttsMs: cumulativeTtsMs,
				firstModelDeltaMs,
				firstSentenceMs,
				firstAudioMs
			};
		}
		#sendJSON(connection, data) {
			const parsed = data;
			if ((parsed.type === "transcript" || parsed.type === "transcript_interim" || parsed.type === "transcript_end") && typeof parsed.text === "string") console.log("[VoiceTrace]", {
				event: parsed.type === "transcript_interim" ? "client_transcript_interim" : "client_transcript",
				connectionId: connection.id,
				role: parsed.type === "transcript_end" ? "assistant" : "user",
				text: parsed.text
			});
			sendVoiceJSON(connection, data, "VoiceAgent", parsed.type === "transcript_delta");
		}
	}
	return VoiceAgentMixin;
}
function eagerAsyncIterable(source) {
	const buffer = [];
	let finished = false;
	let error = null;
	let waitResolve = null;
	const notify = () => {
		if (waitResolve) {
			const resolve = waitResolve;
			waitResolve = null;
			resolve();
		}
	};
	(async () => {
		try {
			for await (const item of source) {
				buffer.push(item);
				notify();
			}
		} catch (err) {
			error = err;
		} finally {
			finished = true;
			notify();
		}
	})();
	return { [Symbol.asyncIterator]() {
		let index = 0;
		return { async next() {
			while (index >= buffer.length && !finished) await new Promise((r) => {
				waitResolve = r;
			});
			if (error) throw error;
			if (index >= buffer.length) return {
				done: true,
				value: void 0
			};
			return {
				done: false,
				value: buffer[index++]
			};
		} };
	} };
}
//#endregion
export { SFUVoiceTransport, SentenceChunker, VOICE_PROTOCOL_VERSION, VoiceRpcCallback, WorkersAIFluxSTT, WorkersAIGrokTTS, WorkersAINova3STT, WorkersAIRealtimeTTS, WorkersAITTS, addSFUTracks, closeSFUWebSocketAdapter, createSFUSession, createSFUWebSocketAdapter, createVoiceAgent, decodeVarint, downsample48kStereoTo16kMono, encodePayloadToProtobuf, encodeVarint, extractPayloadFromProtobuf, iterateText, renegotiateSFUSession, resample24kMonoTo48kStereo, resampleMonoTo48kStereo, sfuFetch, streamRpcVoiceTurn, upsample16kMonoTo48kStereo, withSFUVoice, withVoice, withVoiceInput };

//# sourceMappingURL=voice.js.map
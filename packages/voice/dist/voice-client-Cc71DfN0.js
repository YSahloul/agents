import "./types-RutX7tlR.js";
import { PartySocket } from "partysocket";
//#region src/sfu-voice-client.ts
var StaleStart = class extends Error {};
const DEFAULT_ICE_SERVERS = [{ urls: "stun:stun.cloudflare.com:3478" }];
var SFUVoiceAudioInput = class {
	#endpoint;
	#iceServers;
	#headers;
	#captureMicrophone;
	#jsonHeaders;
	#generation;
	#listenerPeer;
	#microphonePeer;
	#microphoneStream;
	#stopMicrophone;
	#publishedStream;
	#audioElement;
	#analyserContext;
	#animationFrame;
	#shouldStopForwarding;
	constructor(options) {
		this.handlesPlayback = true;
		this.onAudioLevel = null;
		this.onAudioData = null;
		this.#generation = 0;
		this.#listenerPeer = null;
		this.#microphonePeer = null;
		this.#microphoneStream = null;
		this.#stopMicrophone = null;
		this.#publishedStream = null;
		this.#audioElement = null;
		this.#analyserContext = null;
		this.#animationFrame = null;
		this.#shouldStopForwarding = false;
		this.#endpoint = options.endpoint.replace(/\/$/, "");
		this.#iceServers = options.iceServers ?? DEFAULT_ICE_SERVERS;
		this.#captureMicrophone = options.captureMicrophone;
		this.#headers = new Headers(options.headers);
		this.#jsonHeaders = new Headers(this.#headers);
		this.#jsonHeaders.set("Content-Type", "application/json");
	}
	async start() {
		const generation = ++this.#generation;
		this.#teardown(this.#shouldStopForwarding, false);
		this.#shouldStopForwarding = true;
		try {
			await this.#post("tts/publish");
			this.#assertCurrent(generation);
			const listenerPeer = new RTCPeerConnection({ iceServers: this.#iceServers });
			listenerPeer.addTransceiver("audio", { direction: "recvonly" });
			this.#listenerPeer = listenerPeer;
			const audio = document.createElement("audio");
			audio.autoplay = true;
			audio.style.display = "none";
			document.body.appendChild(audio);
			this.#audioElement = audio;
			listenerPeer.ontrack = (event) => {
				if (generation !== this.#generation || this.#listenerPeer !== listenerPeer) return;
				audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
				audio.play().catch((error) => {
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
			const capture = this.#captureMicrophone ? await this.#captureMicrophone() : { stream: await navigator.mediaDevices.getUserMedia({ audio: {
				sampleRate: 48e3,
				channelCount: 2,
				echoCancellation: true,
				noiseSuppression: true,
				autoGainControl: true
			} }) };
			const microphoneStream = capture.stream;
			if (generation !== this.#generation) {
				microphoneStream.getTracks().forEach((track) => track.stop());
				await capture.stop?.();
				throw new StaleStart();
			}
			this.#stopMicrophone = capture.stop ?? null;
			this.#microphoneStream = microphoneStream;
			const publishedStream = await this.#createMicrophoneBridge(microphoneStream, generation);
			this.#publishedStream = publishedStream;
			const microphonePeer = new RTCPeerConnection({ iceServers: this.#iceServers });
			this.#microphonePeer = microphonePeer;
			publishedStream.getTracks().forEach((track) => microphonePeer.addTrack(track, publishedStream));
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
			if (error instanceof StaleStart || generation !== this.#generation) return;
			this.stop();
			throw error;
		}
	}
	stop() {
		this.#generation++;
		this.#teardown(this.#shouldStopForwarding, true);
	}
	#teardown(stopForwarding, clearCallbacks) {
		this.#shouldStopForwarding = false;
		if (stopForwarding) this.#post("stt/stop-forwarding").catch(() => {});
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
		Promise.resolve(stopMicrophone?.()).catch(() => {});
		this.#publishedStream?.getTracks().forEach((track) => track.stop());
		this.#publishedStream = null;
		this.#analyserContext?.close().catch(() => {});
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
	setMuted(muted) {
		this.#microphoneStream?.getTracks().forEach((track) => track.enabled = !muted);
	}
	async setOutputDevice(deviceId) {
		const audio = this.#audioElement;
		if (!audio) return;
		if (!audio.setSinkId) {
			if (deviceId === "default") return;
			throw new DOMException("Audio output selection is not supported by this browser.", "NotSupportedError");
		}
		await audio.setSinkId(deviceId);
	}
	async #connectTts(listenerPeer, offer) {
		const response = await this.#postJSON("tts/connect", { sessionDescription: offer });
		const description = this.#sessionDescription(response);
		if (description) return description;
		if (response.requiresImmediateRenegotiation !== true) throw new Error("TTS connect response missing sessionDescription.sdp");
		const reoffer = await listenerPeer.createOffer();
		await listenerPeer.setLocalDescription(reoffer);
		return this.#requireSessionDescription(await this.#postJSON("tts/renegotiate", { sessionDescription: reoffer }), "TTS renegotiate");
	}
	async #connectStt(offer) {
		return this.#requireSessionDescription(await this.#postJSON("stt/connect", { sessionDescription: offer }), "STT connect");
	}
	async #post(operation) {
		const response = await fetch(`${this.#endpoint}/${operation}`, {
			method: "POST",
			headers: this.#headers
		});
		if (!response.ok) throw new Error(`${operation} failed (${response.status}): ${await response.text()}`);
		return response;
	}
	async #postJSON(operation, body) {
		const response = await fetch(`${this.#endpoint}/${operation}`, {
			method: "POST",
			headers: this.#jsonHeaders,
			body: JSON.stringify(body)
		});
		if (!response.ok) throw new Error(`${operation} failed (${response.status}): ${await response.text()}`);
		const result = await response.json();
		if (typeof result !== "object" || result === null || Array.isArray(result)) throw new Error(`${operation} response must be an object`);
		return result;
	}
	#requireSessionDescription(response, operation) {
		const description = this.#sessionDescription(response);
		if (!description) throw new Error(`${operation} response missing sessionDescription.sdp`);
		return description;
	}
	#sessionDescription(response) {
		const value = response.sessionDescription;
		if (typeof value !== "object" || value === null || !("sdp" in value) || typeof value.sdp !== "string") return null;
		return {
			type: "type" in value && typeof value.type === "string" ? value.type : "answer",
			sdp: value.sdp
		};
	}
	async #createMicrophoneBridge(stream, generation) {
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
	#waitForConnected(peer, generation) {
		if (peer.connectionState === "connected") return Promise.resolve();
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				cleanup();
				reject(/* @__PURE__ */ new Error("Microphone WebRTC connection timed out"));
			}, 15e3);
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
				} else if (peer.connectionState === "failed" || peer.connectionState === "closed") {
					cleanup();
					reject(/* @__PURE__ */ new Error("Microphone WebRTC connection failed"));
				}
			};
			peer.addEventListener("connectionstatechange", onStateChange);
		});
	}
	#assertCurrent(generation) {
		if (generation !== this.#generation) throw new StaleStart();
	}
};
//#endregion
//#region src/voice-client.ts
function camelCaseToKebabCase(str) {
	if (str === str.toUpperCase() && str !== str.toLowerCase()) return str.toLowerCase().replace(/_/g, "-");
	let kebabified = str.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
	kebabified = kebabified.startsWith("-") ? kebabified.slice(1) : kebabified;
	return kebabified.replace(/_/g, "-").replace(/-$/, "");
}
const UNSUPPORTED_OUTPUT_DEVICE_ERROR = "Audio output device selection is not supported in this browser.";
const OUTPUT_DEVICE_SWITCH_ERROR = "Could not switch audio output device.";
const WORKLET_PROCESSOR = `
class AudioCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = [];
    this.sampleRate = sampleRate;
    this.targetRate = 16000;
    this.ratio = this.sampleRate / this.targetRate;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const channelData = input[0];

    // Linear interpolation resampling (e.g. 48kHz → 16kHz).
    // Nearest-neighbor (picking every Nth sample) introduces aliasing
    // artifacts, especially on sibilants (s, f, th). Linear interpolation
    // blends adjacent samples, acting as a basic low-pass filter.
    for (let i = 0; i < channelData.length; i += this.ratio) {
      const idx = Math.floor(i);
      const frac = i - idx;
      if (idx + 1 < channelData.length) {
        this.buffer.push(channelData[idx] * (1 - frac) + channelData[idx + 1] * frac);
      } else if (idx < channelData.length) {
        this.buffer.push(channelData[idx]);
      }
    }

    if (this.buffer.length >= 1600) {
      const chunk = new Float32Array(this.buffer);
      this.port.postMessage({ type: 'audio', samples: chunk }, [chunk.buffer]);
      this.buffer = [];
    }

    return true;
  }
}

registerProcessor('audio-capture-processor', AudioCaptureProcessor);
`;
function floatTo16BitPCM(samples) {
	const buffer = /* @__PURE__ */ new ArrayBuffer(samples.length * 2);
	const view = new DataView(buffer);
	for (let i = 0; i < samples.length; i++) {
		const s = Math.max(-1, Math.min(1, samples[i]));
		view.setInt16(i * 2, s < 0 ? s * 32768 : s * 32767, true);
	}
	return buffer;
}
function computeRMS(samples) {
	let sum = 0;
	for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
	return Math.sqrt(sum / samples.length);
}
/**
* Default VoiceTransport backed by PartySocket (reconnecting WebSocket).
* Created automatically when no custom transport is provided.
*/
var WebSocketVoiceTransport = class {
	#socket;
	#options;
	constructor(options) {
		this.#socket = null;
		this.onopen = null;
		this.onclose = null;
		this.onerror = null;
		this.onmessage = null;
		this.#options = options;
	}
	get connected() {
		return this.#socket?.readyState === WebSocket.OPEN;
	}
	sendJSON(data) {
		if (this.#socket?.readyState === WebSocket.OPEN) this.#socket.send(JSON.stringify(data));
	}
	sendBinary(data) {
		if (this.#socket?.readyState === WebSocket.OPEN) this.#socket.send(data);
	}
	connect() {
		if (this.#socket) return;
		const socket = new PartySocket({
			party: camelCaseToKebabCase(this.#options.agent),
			room: this.#options.name ?? "default",
			host: this.#options.host ?? window.location.host,
			prefix: "agents",
			query: this.#options.query
		});
		socket.onopen = () => this.onopen?.();
		socket.onclose = () => this.onclose?.();
		socket.onerror = () => this.onerror?.();
		socket.onmessage = (event) => {
			this.onmessage?.(event.data);
		};
		this.#socket = socket;
	}
	disconnect() {
		this.#socket?.close();
		this.#socket = null;
	}
};
var VoiceClient = class {
	#status = "idle";
	#transcript = [];
	#metrics = null;
	#audioLevel = 0;
	#isMuted = false;
	#connected = false;
	#error = null;
	#outputDeviceError = null;
	#lastCustomMessage = null;
	#audioFormat = null;
	/** Sample rate for raw pcm16 payloads; set from server `audio_config`. */
	#sampleRate = 16e3;
	#interimTranscript = null;
	#serverProtocolVersion = null;
	#inCall = false;
	#callGeneration = 0;
	#serverCallAcknowledged = false;
	#silenceThreshold;
	#silenceDurationMs;
	#interruptThreshold;
	#interruptChunks;
	#maxTranscriptMessages;
	#transport = null;
	#options;
	#audioContext = null;
	#workletRegistered = false;
	#workletNode = null;
	#stream = null;
	#silenceTimer = null;
	#isSpeaking = false;
	#playbackQueue = [];
	#isPlaying = false;
	#isScheduling = false;
	#scheduledSources = /* @__PURE__ */ new Set();
	#playbackCursor = 0;
	#lastPlaybackEnd = null;
	#playbackElement = null;
	#playbackDestination = null;
	#playbackDestinationPromise = null;
	#useDefaultPlaybackDestination = false;
	#outputDeviceId;
	#outputDeviceSwitchGeneration = 0;
	#playbackOutputGeneration = 0;
	#playbackGeneration = 0;
	#interruptChunkCount = 0;
	#listeners = /* @__PURE__ */ new Map();
	constructor(options) {
		this.#options = options;
		this.#silenceThreshold = options.silenceThreshold ?? .04;
		this.#silenceDurationMs = options.silenceDurationMs ?? 500;
		this.#interruptThreshold = options.interruptThreshold ?? .05;
		this.#interruptChunks = options.interruptChunks ?? 2;
		this.#maxTranscriptMessages = options.maxTranscriptMessages ?? 200;
		this.#outputDeviceId = options.outputDeviceId ?? "default";
	}
	get status() {
		return this.#status;
	}
	get transcript() {
		return this.#transcript;
	}
	get metrics() {
		return this.#metrics;
	}
	get audioLevel() {
		return this.#audioLevel;
	}
	get isMuted() {
		return this.#isMuted;
	}
	get connected() {
		return this.#connected;
	}
	get error() {
		return this.#error;
	}
	get outputDeviceError() {
		return this.#outputDeviceError;
	}
	/**
	* The current interim (partial) transcript from streaming STT.
	* Updates in real time as the user speaks. Cleared when the final
	* transcript is produced. null when no interim text is available.
	*/
	get interimTranscript() {
		return this.#interimTranscript;
	}
	/**
	* The protocol version reported by the server.
	* null until the server sends its welcome message.
	*/
	get serverProtocolVersion() {
		return this.#serverProtocolVersion;
	}
	addEventListener(event, listener) {
		let set = this.#listeners.get(event);
		if (!set) {
			set = /* @__PURE__ */ new Set();
			this.#listeners.set(event, set);
		}
		set.add(listener);
	}
	removeEventListener(event, listener) {
		this.#listeners.get(event)?.delete(listener);
	}
	#emit(event, data) {
		const set = this.#listeners.get(event);
		if (set) for (const listener of set) listener(data);
	}
	#trimTranscript() {
		if (this.#transcript.length > this.#maxTranscriptMessages) this.#transcript = this.#transcript.slice(-this.#maxTranscriptMessages);
	}
	#setOutputDeviceError(error) {
		if (this.#outputDeviceError === error) return;
		this.#outputDeviceError = error;
		this.#emit("outputdeviceerror", error);
	}
	async #setAudioInputOutputDevice(input) {
		if (!input.setOutputDevice) return;
		try {
			await input.setOutputDevice(this.#outputDeviceId);
			this.#setOutputDeviceError(null);
		} catch (error) {
			const unsupported = typeof error === "object" && error !== null && "name" in error && error.name === "NotSupportedError";
			this.#setOutputDeviceError(unsupported ? UNSUPPORTED_OUTPUT_DEVICE_ERROR : OUTPUT_DEVICE_SWITCH_ERROR);
		}
	}
	connect() {
		if (this.#transport) return;
		const transport = this.#options.transport ?? new WebSocketVoiceTransport({
			agent: this.#options.agent,
			name: this.#options.name,
			host: this.#options.host,
			query: this.#options.query
		});
		transport.onopen = () => {
			this.#connected = true;
			this.#error = null;
			transport.sendJSON({
				type: "hello",
				protocol_version: 1
			});
			this.#emit("connectionchange", true);
			this.#emit("error", null);
			if (this.#inCall) {
				this.#serverCallAcknowledged = false;
				transport.sendJSON({ type: "start_call" });
			}
		};
		transport.onclose = () => {
			this.#connected = false;
			this.#emit("connectionchange", false);
		};
		transport.onerror = () => {
			this.#error = "Connection lost. Reconnecting...";
			this.#emit("error", this.#error);
		};
		transport.onmessage = (data) => {
			if (typeof data !== "string" && this.#options.audioInput?.handlesPlayback) return;
			if (typeof data === "string") this.#handleJSONMessage(data);
			else if (data instanceof Blob) data.arrayBuffer().then((buffer) => {
				this.#playbackQueue.push(buffer);
				this.#processPlaybackQueue();
			});
			else if (data instanceof ArrayBuffer) {
				this.#playbackQueue.push(data);
				this.#processPlaybackQueue();
			}
		};
		this.#transport = transport;
		transport.connect();
	}
	disconnect() {
		this.endCall();
		this.#transport?.disconnect();
		this.#transport = null;
		this.#connected = false;
		this.#emit("connectionchange", false);
	}
	async startCall() {
		if (!this.#transport?.connected) {
			this.#error = "Cannot start call: not connected. Call connect() first.";
			this.#emit("error", this.#error);
			return;
		}
		if (this.#inCall) return;
		const callGeneration = ++this.#callGeneration;
		this.#inCall = true;
		this.#serverCallAcknowledged = false;
		this.#error = null;
		this.#metrics = null;
		this.#emit("error", null);
		this.#emit("metricschange", null);
		const startMsg = { type: "start_call" };
		if (this.#options.preferredFormat) startMsg.preferred_format = this.#options.preferredFormat;
		const audioInput = this.#options.audioInput;
		if (!audioInput?.handlesPlayback) this.#transport.sendJSON(startMsg);
		if (!audioInput?.handlesPlayback) {
			const ctx = await this.#getAudioContext();
			if (this.#abortStaleCallStartup(callGeneration)) return;
			await this.#getPlaybackDestination(ctx);
			if (this.#abortStaleCallStartup(callGeneration)) return;
		}
		if (audioInput) {
			audioInput.onAudioLevel = (rms) => this.#processAudioLevel(rms);
			audioInput.onAudioData = (pcm) => {
				if (this.#transport?.connected && !this.#isMuted) this.#transport.sendBinary(pcm);
			};
			try {
				await audioInput.start();
				if (this.#abortStaleCallStartup(callGeneration)) return;
				audioInput.setMuted?.(this.#isMuted);
				await this.#setAudioInputOutputDevice(audioInput);
			} catch (error) {
				if (!this.#isCurrentCallStartup(callGeneration)) return;
				this.#callGeneration++;
				this.#inCall = false;
				this.#serverCallAcknowledged = false;
				if (this.#transport?.connected && !audioInput.handlesPlayback) this.#transport.sendJSON({ type: "end_call" });
				this.#stopLocalCall();
				this.#status = "idle";
				this.#emit("statuschange", "idle");
				this.#error = error instanceof Error ? error.message : "Custom audio input failed to start";
				this.#emit("error", this.#error);
				throw error;
			}
		} else await this.#startMic();
		if (audioInput?.handlesPlayback) this.#transport.sendJSON(startMsg);
		this.#abortStaleCallStartup(callGeneration);
	}
	endCall() {
		this.#callGeneration++;
		this.#inCall = false;
		this.#serverCallAcknowledged = false;
		if (this.#transport?.connected) this.#transport.sendJSON({ type: "end_call" });
		this.#stopLocalCall();
		this.#status = "idle";
		this.#emit("statuschange", "idle");
	}
	#isCurrentCallStartup(callGeneration) {
		return this.#inCall && this.#callGeneration === callGeneration;
	}
	#abortStaleCallStartup(callGeneration) {
		if (this.#isCurrentCallStartup(callGeneration)) return false;
		if (!this.#inCall) this.#stopLocalCall();
		return true;
	}
	#stopLocalCall() {
		if (this.#options.audioInput) {
			this.#options.audioInput.stop();
			this.#options.audioInput.onAudioLevel = null;
			this.#options.audioInput.onAudioData = null;
		} else this.#stopMic();
		this.#stopPlayback();
		this.#closeAudioContext();
		this.#resetDetection();
	}
	toggleMute() {
		this.#isMuted = !this.#isMuted;
		if (this.#isMuted) {
			this.#audioLevel = 0;
			this.#emit("audiolevelchange", 0);
		}
		if (this.#isMuted && this.#isSpeaking) {
			this.#isSpeaking = false;
			if (this.#silenceTimer) {
				clearTimeout(this.#silenceTimer);
				this.#silenceTimer = null;
			}
			if (this.#transport?.connected) this.#transport.sendJSON({ type: "end_of_speech" });
		}
		this.#options.audioInput?.setMuted?.(this.#isMuted);
		this.#emit("mutechange", this.#isMuted);
	}
	/**
	* Send a text message to the agent. The agent processes it through
	* `onTurn()` (bypassing STT) and responds with text transcript and
	* TTS audio (if in a call) or text-only (if not).
	*/
	sendText(text) {
		if (this.#transport?.connected) this.#transport.sendJSON({
			type: "text_message",
			text
		});
	}
	/**
	* Send arbitrary JSON to the agent. Use this for app-level messages
	* that are not part of the voice protocol (e.g. `{ type: "kick_speaker" }`).
	* The server receives these in the consumer's `onMessage()` handler.
	*/
	sendJSON(data) {
		if (this.#transport?.connected) this.#transport.sendJSON(data);
	}
	/**
	* Set the preferred audio output device for assistant playback.
	* Unsupported browsers continue playing through the default output.
	*/
	async setOutputDevice(outputDeviceId) {
		this.#outputDeviceId = outputDeviceId ?? "default";
		const audioInput = this.#options.audioInput;
		if (audioInput?.setOutputDevice) {
			await this.#setAudioInputOutputDevice(audioInput);
			return;
		}
		const generation = ++this.#outputDeviceSwitchGeneration;
		if (this.#playbackElement) await this.#applyOutputDevice(this.#playbackElement, generation);
	}
	/**
	* The last custom (non-voice-protocol) message received from the server.
	* Listen for the `"custommessage"` event to be notified when this changes.
	*/
	get lastCustomMessage() {
		return this.#lastCustomMessage;
	}
	/**
	* The audio format the server declared for binary payloads.
	* Set when the server sends `audio_config` at call start.
	*/
	get audioFormat() {
		return this.#audioFormat;
	}
	/**
	* The sample rate (Hz) the server declared for raw pcm16 payloads.
	* Set when the server sends `audio_config` at call start. Defaults to 16000.
	*/
	get sampleRate() {
		return this.#sampleRate;
	}
	#handleJSONMessage(data) {
		let msg;
		try {
			msg = JSON.parse(data);
		} catch {
			return;
		}
		switch (msg.type) {
			case "welcome":
				this.#serverProtocolVersion = msg.protocol_version;
				if (msg.protocol_version !== 1) console.warn(`[VoiceClient] Protocol version mismatch: client=1, server=${msg.protocol_version}`);
				break;
			case "audio_config":
				this.#serverCallAcknowledged = true;
				this.#audioFormat = msg.format;
				this.#sampleRate = typeof msg.sampleRate === "number" && msg.sampleRate > 0 ? msg.sampleRate : 16e3;
				break;
			case "status":
				this.#status = msg.status;
				if (msg.status === "idle" && this.#inCall) {
					if (!(this.#serverCallAcknowledged || this.#error !== null)) {
						this.#emit("statuschange", this.#status);
						break;
					}
					this.#callGeneration++;
					this.#inCall = false;
					this.#serverCallAcknowledged = false;
					this.#stopLocalCall();
				}
				if (msg.status === "listening") {
					this.#serverCallAcknowledged = true;
					this.#error = null;
					this.#emit("error", null);
				} else if (msg.status === "thinking" || msg.status === "speaking") this.#serverCallAcknowledged = true;
				this.#emit("statuschange", this.#status);
				break;
			case "transcript_interim":
				this.#interimTranscript = msg.text;
				this.#emit("interimtranscript", this.#interimTranscript);
				break;
			case "playback_interrupt":
				this.#stopPlayback();
				break;
			case "transcript":
				this.#interimTranscript = null;
				this.#emit("interimtranscript", null);
				if (msg.role === "user" && this.#isPlaying) this.#stopPlayback();
				this.#transcript = [...this.#transcript, {
					role: msg.role,
					text: msg.text,
					timestamp: Date.now()
				}];
				this.#trimTranscript();
				this.#emit("transcriptchange", this.#transcript);
				break;
			case "transcript_start":
				this.#transcript = [...this.#transcript, {
					role: "assistant",
					text: "",
					timestamp: Date.now()
				}];
				this.#trimTranscript();
				this.#emit("transcriptchange", this.#transcript);
				break;
			case "transcript_delta": {
				if (this.#transcript.length === 0) break;
				const updated = [...this.#transcript];
				const last = updated[updated.length - 1];
				if (last.role === "assistant") {
					updated[updated.length - 1] = {
						...last,
						text: last.text + msg.text
					};
					this.#transcript = updated;
					this.#emit("transcriptchange", this.#transcript);
				}
				break;
			}
			case "transcript_end": {
				if (this.#transcript.length === 0) break;
				const updated = [...this.#transcript];
				const last = updated[updated.length - 1];
				if (last.role === "assistant") {
					updated[updated.length - 1] = {
						...last,
						text: msg.text
					};
					this.#transcript = updated;
					this.#emit("transcriptchange", this.#transcript);
				}
				break;
			}
			case "metrics":
				this.#metrics = {
					llm_ms: msg.llm_ms,
					tts_ms: msg.tts_ms,
					first_audio_ms: msg.first_audio_ms,
					total_ms: msg.total_ms
				};
				this.#emit("metricschange", this.#metrics);
				break;
			case "error":
				this.#error = msg.message;
				this.#emit("error", this.#error);
				break;
			default:
				this.#lastCustomMessage = msg;
				this.#emit("custommessage", msg);
				break;
		}
	}
	/** Get or create the shared AudioContext. */
	async #getAudioContext() {
		if (!this.#audioContext) this.#audioContext = new AudioContext({ sampleRate: 48e3 });
		if (this.#audioContext.state === "suspended") await this.#audioContext.resume();
		return this.#audioContext;
	}
	/** Close the AudioContext and release resources. */
	#closeAudioContext() {
		if (this.#audioContext) {
			this.#closePlaybackOutput();
			this.#audioContext.close().catch(() => {});
			this.#audioContext = null;
			this.#workletRegistered = false;
		}
	}
	async #getPlaybackDestination(ctx) {
		if (this.#playbackDestinationPromise) return this.#playbackDestinationPromise;
		if (this.#playbackDestination) return this.#playbackDestination;
		if (this.#useDefaultPlaybackDestination) return ctx.destination;
		const outputGeneration = this.#playbackOutputGeneration;
		const promise = this.#initializePlaybackDestination(ctx, outputGeneration);
		this.#playbackDestinationPromise = promise;
		try {
			return await promise;
		} finally {
			if (this.#playbackDestinationPromise === promise) this.#playbackDestinationPromise = null;
		}
	}
	async #initializePlaybackDestination(ctx, outputGeneration) {
		try {
			const destination = ctx.createMediaStreamDestination();
			const audio = new Audio();
			audio.autoplay = true;
			audio.srcObject = destination.stream;
			this.#playbackElement = audio;
			this.#playbackDestination = destination;
			await this.#applyOutputDevice(audio, this.#outputDeviceSwitchGeneration);
			if (!this.#isCurrentPlaybackOutput(audio, outputGeneration)) {
				this.#releasePlaybackElement(audio);
				return ctx.destination;
			}
			await audio.play();
			if (!this.#isCurrentPlaybackOutput(audio, outputGeneration)) {
				this.#releasePlaybackElement(audio);
				return ctx.destination;
			}
			return destination;
		} catch (err) {
			console.warn("[VoiceClient] HTMLAudioElement playback output unavailable; using default AudioContext destination.", err);
			this.#closePlaybackOutput();
			this.#useDefaultPlaybackDestination = true;
			return ctx.destination;
		}
	}
	#isCurrentPlaybackOutput(audio, outputGeneration) {
		return this.#playbackElement === audio && this.#playbackOutputGeneration === outputGeneration;
	}
	async #applyOutputDevice(audio, generation) {
		const sinkId = this.#outputDeviceId;
		const setSinkId = audio.setSinkId;
		if (!setSinkId) {
			if (sinkId === "default") {
				this.#setOutputDeviceError(null);
				return;
			}
			this.#setOutputDeviceError(UNSUPPORTED_OUTPUT_DEVICE_ERROR);
			return;
		}
		try {
			await setSinkId.call(audio, sinkId);
			if (generation !== this.#outputDeviceSwitchGeneration || sinkId !== this.#outputDeviceId) {
				if (this.#playbackElement === audio) await this.#applyOutputDevice(audio, this.#outputDeviceSwitchGeneration);
				return;
			}
			if (this.#outputDeviceError === UNSUPPORTED_OUTPUT_DEVICE_ERROR || this.#outputDeviceError === OUTPUT_DEVICE_SWITCH_ERROR) this.#setOutputDeviceError(null);
		} catch {
			if (generation !== this.#outputDeviceSwitchGeneration || sinkId !== this.#outputDeviceId) {
				if (this.#playbackElement === audio) await this.#applyOutputDevice(audio, this.#outputDeviceSwitchGeneration);
				return;
			}
			this.#setOutputDeviceError(OUTPUT_DEVICE_SWITCH_ERROR);
		}
	}
	#closePlaybackOutput() {
		this.#playbackOutputGeneration++;
		if (this.#playbackElement) {
			this.#releasePlaybackElement(this.#playbackElement);
			this.#playbackElement = null;
		}
		this.#playbackDestination = null;
		this.#playbackDestinationPromise = null;
		this.#useDefaultPlaybackDestination = false;
	}
	#releasePlaybackElement(audio) {
		audio.pause();
		audio.srcObject = null;
	}
	async #playAudio(audioData, generation) {
		try {
			const ctx = await this.#getAudioContext();
			let audioBuffer;
			if (this.#audioFormat === "pcm16") {
				const int16 = new Int16Array(audioData);
				audioBuffer = ctx.createBuffer(1, int16.length, this.#sampleRate);
				const channel = audioBuffer.getChannelData(0);
				for (let i = 0; i < int16.length; i++) channel[i] = int16[i] / 32768;
			} else audioBuffer = await ctx.decodeAudioData(audioData.slice(0));
			if (generation !== this.#playbackGeneration) return;
			if (this.#playbackElement && this.#scheduledSources.size === 0 && this.#lastPlaybackEnd !== null && ctx.currentTime - this.#lastPlaybackEnd > .3) this.#closePlaybackOutput();
			const destination = await this.#getPlaybackDestination(ctx);
			if (generation !== this.#playbackGeneration) return;
			const source = ctx.createBufferSource();
			source.buffer = audioBuffer;
			source.connect(destination);
			this.#scheduledSources.add(source);
			source.onended = () => {
				this.#scheduledSources.delete(source);
				if (generation === this.#playbackGeneration && !this.#isScheduling && this.#scheduledSources.size === 0 && this.#playbackQueue.length === 0) this.#isPlaying = false;
			};
			const startAt = Math.max(ctx.currentTime, this.#playbackCursor);
			this.#playbackCursor = startAt + audioBuffer.duration;
			this.#lastPlaybackEnd = this.#playbackCursor;
			source.start(startAt);
		} catch (err) {
			console.error("[VoiceClient] Audio playback error:", err);
		}
	}
	async #processPlaybackQueue() {
		if (this.#isScheduling || this.#playbackQueue.length === 0) return;
		this.#isScheduling = true;
		this.#isPlaying = true;
		const generation = this.#playbackGeneration;
		while (generation === this.#playbackGeneration && this.#playbackQueue.length > 0) {
			const audioData = this.#playbackQueue.shift();
			await this.#playAudio(audioData, generation);
		}
		if (generation === this.#playbackGeneration) {
			this.#isScheduling = false;
			if (this.#scheduledSources.size === 0) this.#isPlaying = false;
		}
	}
	#stopPlayback() {
		this.#playbackGeneration++;
		const sources = [...this.#scheduledSources];
		this.#scheduledSources.clear();
		for (const source of sources) try {
			source.stop();
		} catch {}
		this.#playbackQueue = [];
		this.#isPlaying = false;
		this.#isScheduling = false;
		this.#playbackCursor = 0;
		this.#lastPlaybackEnd = this.#audioContext ? this.#audioContext.currentTime : null;
	}
	async #startMic() {
		try {
			const stream = await navigator.mediaDevices.getUserMedia({ audio: {
				sampleRate: { ideal: 48e3 },
				channelCount: 1,
				echoCancellation: true,
				noiseSuppression: true,
				autoGainControl: true
			} });
			this.#stream = stream;
			const ctx = await this.#getAudioContext();
			if (!this.#workletRegistered) {
				const blob = new Blob([WORKLET_PROCESSOR], { type: "application/javascript" });
				const workletUrl = URL.createObjectURL(blob);
				await ctx.audioWorklet.addModule(workletUrl);
				URL.revokeObjectURL(workletUrl);
				this.#workletRegistered = true;
			}
			const source = ctx.createMediaStreamSource(stream);
			const workletNode = new AudioWorkletNode(ctx, "audio-capture-processor");
			this.#workletNode = workletNode;
			workletNode.port.onmessage = (event) => {
				if (event.data.type === "audio" && !this.#isMuted) {
					const samples = event.data.samples;
					const rms = computeRMS(samples);
					const pcm = floatTo16BitPCM(samples);
					if (this.#transport?.connected) this.#transport.sendBinary(pcm);
					this.#processAudioLevel(rms);
				}
			};
			source.connect(workletNode);
			workletNode.connect(ctx.destination);
		} catch (err) {
			console.error("[VoiceClient] Mic error:", err);
			this.#error = "Microphone access denied. Please allow microphone access and try again.";
			this.#emit("error", this.#error);
		}
	}
	#stopMic() {
		this.#workletNode?.disconnect();
		this.#workletNode = null;
		this.#stream?.getTracks().forEach((track) => track.stop());
		this.#stream = null;
		this.#resetDetection();
	}
	#processAudioLevel(rms) {
		if (this.#isMuted) return;
		this.#audioLevel = rms;
		this.#emit("audiolevelchange", rms);
		if (this.#isPlaying && rms > this.#interruptThreshold) {
			this.#interruptChunkCount++;
			if (this.#interruptChunkCount >= this.#interruptChunks) {
				this.#stopPlayback();
				this.#interruptChunkCount = 0;
				if (this.#transport?.connected) this.#transport.sendJSON({ type: "interrupt" });
			}
		} else this.#interruptChunkCount = 0;
		if (rms > this.#silenceThreshold) {
			if (!this.#isSpeaking) {
				this.#isSpeaking = true;
				if (this.#transport?.connected) this.#transport.sendJSON({ type: "start_of_speech" });
			}
			if (this.#silenceTimer) {
				clearTimeout(this.#silenceTimer);
				this.#silenceTimer = null;
			}
		} else if (this.#isSpeaking) {
			if (!this.#silenceTimer) this.#silenceTimer = setTimeout(() => {
				this.#isSpeaking = false;
				this.#silenceTimer = null;
				if (this.#transport?.connected) this.#transport.sendJSON({ type: "end_of_speech" });
			}, this.#silenceDurationMs);
		}
	}
	#resetDetection() {
		if (this.#silenceTimer) {
			clearTimeout(this.#silenceTimer);
			this.#silenceTimer = null;
		}
		this.#isSpeaking = false;
		this.#interruptChunkCount = 0;
		this.#audioLevel = 0;
		this.#emit("audiolevelchange", 0);
	}
};
//#endregion
export { WebSocketVoiceTransport as n, SFUVoiceAudioInput as r, VoiceClient as t };

//# sourceMappingURL=voice-client-Cc71DfN0.js.map
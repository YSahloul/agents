import { n as WebSocketVoiceTransport, r as SFUVoiceAudioInput, t as VoiceClient } from "./voice-client-Cc71DfN0.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
//#region src/voice-react.tsx
/**
* React hook for voice-to-text input. Captures microphone audio, streams it
* to a server-side VoiceAgent for STT, and returns the transcript as a string.
*
* Unlike `useVoiceAgent`, this hook is optimised for dictation — it accumulates
* user transcripts into a single string and ignores assistant responses / TTS.
*
* @example
* ```tsx
* const { transcript, interimTranscript, isListening, start, stop } = useVoiceInput({
*   agent: "voice-input-agent"
* });
*
* <textarea value={transcript + (interimTranscript ? " " + interimTranscript : "")} />
* <button onClick={isListening ? stop : start}>
*   {isListening ? "Stop" : "Dictate"}
* </button>
* ```
*/
function useVoiceInput(options) {
	const connectionKey = useMemo(() => `${options.agent}:${options.name ?? "default"}:${options.host ?? ""}:${options.silenceThreshold ?? ""}:${options.silenceDurationMs ?? ""}`, [
		options.agent,
		options.name,
		options.host,
		options.silenceThreshold,
		options.silenceDurationMs
	]);
	const clientRef = useRef(null);
	const [transcript, setTranscript] = useState("");
	const [interimTranscript, setInterimTranscript] = useState(null);
	const [isListening, setIsListening] = useState(false);
	const [audioLevel, setAudioLevel] = useState(0);
	const [isMuted, setIsMuted] = useState(false);
	const [error, setError] = useState(null);
	useEffect(() => {
		setIsListening(false);
		setInterimTranscript(null);
		setAudioLevel(0);
		setIsMuted(false);
		setError(null);
		const client = new VoiceClient({
			agent: options.agent,
			name: options.name,
			host: options.host,
			silenceThreshold: options.silenceThreshold,
			silenceDurationMs: options.silenceDurationMs
		});
		clientRef.current = client;
		client.connect();
		const onTranscript = () => {
			setTranscript(client.transcript.filter((m) => m.role === "user").map((m) => m.text).join(" "));
		};
		const onInterim = () => setInterimTranscript(client.interimTranscript);
		const onAudioLevel = () => setAudioLevel(client.audioLevel);
		const onMute = () => setIsMuted(client.isMuted);
		const onError = () => setError(client.error);
		const onStatus = () => {
			const s = client.status;
			setIsListening(s === "listening" || s === "thinking");
		};
		client.addEventListener("transcriptchange", onTranscript);
		client.addEventListener("interimtranscript", onInterim);
		client.addEventListener("audiolevelchange", onAudioLevel);
		client.addEventListener("mutechange", onMute);
		client.addEventListener("error", onError);
		client.addEventListener("statuschange", onStatus);
		return () => {
			client.removeEventListener("transcriptchange", onTranscript);
			client.removeEventListener("interimtranscript", onInterim);
			client.removeEventListener("audiolevelchange", onAudioLevel);
			client.removeEventListener("mutechange", onMute);
			client.removeEventListener("error", onError);
			client.removeEventListener("statuschange", onStatus);
			client.disconnect();
		};
	}, [connectionKey]);
	return {
		transcript,
		interimTranscript,
		isListening,
		audioLevel,
		isMuted,
		error,
		start: useCallback(() => clientRef.current.startCall(), []),
		stop: useCallback(() => clientRef.current.endCall(), []),
		toggleMute: useCallback(() => clientRef.current.toggleMute(), []),
		clear: useCallback(() => setTranscript(""), [])
	};
}
/**
* React hook that wraps VoiceClient, syncing its state into React state.
* All audio infrastructure (mic capture, playback, silence/interrupt detection,
* voice protocol) is handled by VoiceClient — this hook just bridges to React.
*
* When the connection identity changes (agent, name, or host), the hook
* automatically disconnects the old client, creates a new one, and reconnects.
* The `onReconnect` callback fires when this happens.
*/
function useVoiceAgent(options) {
	const queryString = useMemo(() => options.query ? JSON.stringify(options.query) : "", [options.query]);
	const enabled = options.enabled ?? true;
	const outputDeviceId = options.outputDeviceId;
	const connectionKey = useMemo(() => `${options.agent}:${options.name ?? "default"}:${options.host ?? ""}:${options.silenceThreshold ?? ""}:${options.silenceDurationMs ?? ""}:${options.interruptThreshold ?? ""}:${options.interruptChunks ?? ""}:${queryString}`, [
		options.agent,
		options.name,
		options.host,
		options.silenceThreshold,
		options.silenceDurationMs,
		options.interruptThreshold,
		options.interruptChunks,
		queryString
	]);
	const effectKey = useMemo(() => `${enabled ? "enabled" : "disabled"}:${connectionKey}`, [enabled, connectionKey]);
	const clientRef = useRef(null);
	const activeKeyRef = useRef(null);
	const onReconnectRef = useRef(options.onReconnect);
	onReconnectRef.current = options.onReconnect;
	const [status, setStatus] = useState("idle");
	const [transcript, setTranscript] = useState([]);
	const [metrics, setMetrics] = useState(null);
	const [audioLevel, setAudioLevel] = useState(0);
	const [isMuted, setIsMuted] = useState(false);
	const [connected, setConnected] = useState(false);
	const [error, setError] = useState(null);
	const [outputDeviceError, setOutputDeviceError] = useState(null);
	const [interimTranscript, setInterimTranscript] = useState(null);
	const [lastCustomMessage, setLastCustomMessage] = useState(null);
	useEffect(() => {
		setStatus("idle");
		setTranscript([]);
		setMetrics(null);
		setAudioLevel(0);
		setIsMuted(false);
		setConnected(false);
		setError(null);
		setOutputDeviceError(null);
		setInterimTranscript(null);
		setLastCustomMessage(null);
		if (!enabled) {
			clientRef.current = null;
			activeKeyRef.current = null;
			return;
		}
		const isReconnect = activeKeyRef.current !== null && activeKeyRef.current !== connectionKey;
		activeKeyRef.current = connectionKey;
		if (isReconnect) onReconnectRef.current?.();
		const { enabled: _enabled, onReconnect: _onReconnect, ...clientOptions } = options;
		const client = new VoiceClient(clientOptions);
		clientRef.current = client;
		client.connect();
		const onStatus = (s) => setStatus(s);
		const onTranscript = (t) => setTranscript(t);
		const onMetrics = (m) => setMetrics(m);
		const onAudioLevel = (level) => setAudioLevel(level);
		const onMute = (muted) => setIsMuted(muted);
		const onConnection = (c) => setConnected(c);
		const onError = (e) => setError(e);
		const onOutputDeviceError = (e) => setOutputDeviceError(e);
		const onInterim = (text) => setInterimTranscript(text);
		client.addEventListener("statuschange", onStatus);
		client.addEventListener("transcriptchange", onTranscript);
		client.addEventListener("interimtranscript", onInterim);
		client.addEventListener("metricschange", onMetrics);
		client.addEventListener("audiolevelchange", onAudioLevel);
		client.addEventListener("mutechange", onMute);
		client.addEventListener("connectionchange", onConnection);
		client.addEventListener("error", onError);
		client.addEventListener("outputdeviceerror", onOutputDeviceError);
		return () => {
			client.removeEventListener("statuschange", onStatus);
			client.removeEventListener("transcriptchange", onTranscript);
			client.removeEventListener("interimtranscript", onInterim);
			client.removeEventListener("metricschange", onMetrics);
			client.removeEventListener("audiolevelchange", onAudioLevel);
			client.removeEventListener("mutechange", onMute);
			client.removeEventListener("connectionchange", onConnection);
			client.removeEventListener("error", onError);
			client.removeEventListener("outputdeviceerror", onOutputDeviceError);
			if (clientRef.current === client) clientRef.current = null;
			client.disconnect();
		};
	}, [effectKey]);
	const startCall = useCallback(() => clientRef.current?.startCall() ?? Promise.resolve(), []);
	const endCall = useCallback(() => clientRef.current?.endCall(), []);
	const toggleMute = useCallback(() => clientRef.current?.toggleMute(), []);
	const sendText = useCallback((text) => clientRef.current?.sendText(text), []);
	const sendJSON = useCallback((data) => clientRef.current?.sendJSON(data), []);
	useEffect(() => {
		const client = clientRef.current;
		if (!client) return;
		const onCustom = (msg) => setLastCustomMessage(msg);
		client.addEventListener("custommessage", onCustom);
		return () => client.removeEventListener("custommessage", onCustom);
	}, [effectKey]);
	useEffect(() => {
		clientRef.current?.setOutputDevice(outputDeviceId);
	}, [effectKey, outputDeviceId]);
	return {
		status,
		transcript,
		interimTranscript,
		metrics,
		audioLevel,
		isMuted,
		connected,
		error,
		outputDeviceError,
		startCall,
		endCall,
		toggleMute,
		sendText,
		sendJSON,
		lastCustomMessage
	};
}
//#endregion
export { SFUVoiceAudioInput, WebSocketVoiceTransport, useVoiceAgent, useVoiceInput };

//# sourceMappingURL=voice-react.js.map
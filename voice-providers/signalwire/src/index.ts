import {
  arrayBufferToBase64,
  meanSquaredEnergy,
  pcm16ToSignalWireMulaw,
  signalWireMulawToPcm16
} from "./audio/utils.js";
import type {
  SignalWireDtmfMessage,
  SignalWireMediaMessage,
  SignalWireStartMessage
} from "./types.js";

/** Mirrors `camelCaseToKebabCase` in `agents/src/utils.ts` — kept local to
 * avoid depending on the `agents` package for one pure function. */
function agentNameToRoutePath(str: string): string {
  if (str === str.toUpperCase() && str !== str.toLowerCase()) {
    return str.toLowerCase().replace(/_/g, "-");
  }
  let kebabified = str.replace(
    /[A-Z]/g,
    (letter) => `-${letter.toLowerCase()}`
  );
  kebabified = kebabified.startsWith("-") ? kebabified.slice(1) : kebabified;
  return kebabified.replace(/_/g, "-").replace(/-$/, "");
}

export type SignalWireAgentAudioFormat = "mulaw" | "pcm16";

export interface SignalWireAdapterOptions {
  /** Defaults to SignalWire's Call SID, giving every call its own agent. */
  instanceName?: string;
  /**
   * Encoding of the binary audio frames the connected VoiceAgent sends back.
   * - "pcm16" (default): raw signed 16-bit little-endian PCM. The rate is not
   *   guessed — it is read from the agent's `audio_config` message, which the
   *   voice runtime derives from the TTS provider's own declared
   *   `sampleRate` (e.g. 8000 for `WorkersAIMulawRealtimeTTS`).
   * - "mulaw": the agent's TTS already emits 8 kHz μ-law — frames are
   *   forwarded unchanged, byte for byte.
   * @default "pcm16"
   */
  agentAudioFormat?: SignalWireAgentAudioFormat;
  /**
   * PCM16 rate for inbound carrier → agent audio. This must match the rate
   * the agent's *STT* provider expects, which is independent of the TTS
   * output rate (`WorkersAIFluxSTT` defaults to 16000).
   * @default 16000
   */
  sttSampleRate?: number;
  /**
   * Log a line for every inbound 20 ms frame while the agent is speaking
   * (energy, gate state, playback countdown). That is ~50 lines/second —
   * it buries every useful log in a call. Off by default; turn it on only
   * when tuning the echo gate itself.
   * @default false
   */
  debugAudio?: boolean;
}

/** Fallback until the agent's `audio_config` announces the real TTS rate. */

// Energy threshold for speech detection — filters ambient mic noise.
// Mean squared amplitude > 250,000 ≈ RMS > 500 out of ±32,767.
const SPEECH_ENERGY_THRESHOLD = 250_000;

// Consecutive loud frames required before treating inbound audio as real
// caller speech (≈60ms at 8kHz/20ms frames) — debounces transient noise.
const SPEECH_DEBOUNCE_FRAMES = 3;

// Keep a small allowance after estimated playback ends for network and
// SignalWire queue latency before considering the agent silent.
const PLAYBACK_GRACE_MS = 1000;

// EXPERIMENT — echo gate off. When false, inbound caller audio is forwarded
// to the agent unconditionally: no ducking while the agent speaks, no
// energy/debounce barge-in, no PLAYBACK_GRACE_MS dead window after playback.
// Barge-in then relies solely on the STT's own speech detection. Expect the
// agent to hear itself on a speakerphone/trunk with echo. Flip back to true
// to restore the gate.
const ECHO_GATE_ENABLED = false;
const DEFAULT_AGENT_SAMPLE_RATE = 16000;

/** Bridges a SignalWire bidirectional cXML Stream to a VoiceAgent. */
export class SignalWireAdapter {
  static handleRequest(
    request: Request,
    env: Record<string, unknown>,
    agentName: string,
    options?: SignalWireAdapterOptions
  ): Response {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const { 0: signalWireSocket, 1: serverSocket } = new WebSocketPair();
    serverSocket.accept();

    let streamSid: string | null = null;
    let agentSocket: WebSocket | null = null;
    // Set from the agent's `audio_config`, which the voice runtime derives
    // from the TTS provider's declared rate. Never guessed here.
    let agentSampleRate = DEFAULT_AGENT_SAMPLE_RATE;

    // audioGated suppresses stale agent audio after local speech detection.
    // The gate remains raised until the agent confirms interruption or starts
    // the next turn.
    let audioGated = false;

    // Barge-in is only armed while SignalWire is estimated to still be
    // playing queued audio and only fires after a few consecutive loud
    // frames, so line noise, caller backchannels, and echo do not spuriously
    // cut playback.
    let estimatedPlaybackEndAt = 0;
    let loudFrames = 0;

    // Bytes per second of agent audio — depends on format and sample rate.
    // mulaw passthrough: 8000 bytes/sec. PCM16: sampleRate * 2 bytes/sec.
    let agentBytesPerSec =
      options?.agentAudioFormat === "mulaw"
        ? 8000
        : DEFAULT_AGENT_SAMPLE_RATE * 2;

    const sendClearAudio = () => {
      estimatedPlaybackEndAt = 0;
      if (serverSocket.readyState === WebSocket.OPEN) {
        serverSocket.send(JSON.stringify({ event: "clear", streamSid }));
      }
    };

    const endAgentCall = () => {
      if (agentSocket?.readyState !== WebSocket.OPEN) return;
      agentSocket.send(JSON.stringify({ type: "end_call" }));
      agentSocket.close();
    };

    const connectToAgent = async (instanceId: string) => {
      const namespace = env[agentName] as DurableObjectNamespace | undefined;
      if (!namespace) {
        console.error(
          `[SignalWireAdapter] DO namespace "${agentName}" not found in env`
        );
        return;
      }

      const stub = namespace.get(namespace.idFromName(instanceId));
      const agentUrl = new URL(request.url);
      agentUrl.protocol = "https:";
      agentUrl.pathname = `/agents/${agentNameToRoutePath(agentName)}/${encodeURIComponent(instanceId)}`;

      const response = await stub.fetch(
        new Request(agentUrl, { headers: { Upgrade: "websocket" } })
      );
      const socket = response.webSocket;
      if (!socket) {
        console.error("[SignalWireAdapter] Failed to connect to VoiceAgent");
        return;
      }

      socket.accept();
      // Cloudflare's `websocket_standard_binary_type` compat flag defaults a
      // server-accepted WebSocket's `binaryType` to "blob", so without this
      // pin every binary TTS audio frame the DO sends arrives here as a
      // `Blob` instead of an `ArrayBuffer` and gets silently dropped by the
      // `instanceof ArrayBuffer` check below.
      try {
        socket.binaryType = "arraybuffer";
      } catch {
        // Some runtimes may not expose a settable `binaryType`.
      }
      agentSocket = socket;

      socket.addEventListener("message", (event) => {
        if (!streamSid) return;

        if (typeof event.data === "string") {
          try {
            const message = JSON.parse(event.data) as Record<string, unknown>;
            if (
              message.type === "audio_config" &&
              typeof message.sampleRate === "number" &&
              message.sampleRate > 0
            ) {
              agentSampleRate = message.sampleRate;
              if (options?.agentAudioFormat !== "mulaw") {
                agentBytesPerSec = agentSampleRate * 2;
              }
            }
            if (message.type === "playback_interrupt") {
              // The agent's transcriber can detect speech that the local
              // energy heuristic misses. Clear SignalWire unless the local
              // path already did, then release the gate at this ordered
              // boundary.
              console.log(
                "[SignalWireAdapter] GATE RELEASED — playback_interrupt (wasGated:",
                audioGated,
                ")"
              );
              if (!audioGated) sendClearAudio();
              audioGated = false;
              loudFrames = 0;
              return;
            }
            if (
              message.type === "status" &&
              (message.status === "listening" ||
                message.status === "thinking" ||
                message.status === "speaking")
            ) {
              // Status transitions are ordered after the previous pipeline's
              // audio, so no stale chunk can follow this boundary.
              console.log(
                "[SignalWireAdapter] GATE RELEASED — status:",
                message.status,
                "(wasGated:",
                audioGated,
                ")"
              );
              audioGated = false;
            }
            if (
              serverSocket.readyState === WebSocket.OPEN &&
              (message.type === "transcript" ||
                message.type === "transcript_end" ||
                message.type === "status")
            ) {
              serverSocket.send(
                JSON.stringify({
                  event: "mark",
                  streamSid,
                  mark: { name: JSON.stringify(message) }
                })
              );
            }
          } catch {
            // Ignore non-JSON text from the agent.
          }
          return;
        }
        if (!(event.data instanceof ArrayBuffer)) return;
        if (audioGated) {
          if (options?.debugAudio) {
            console.log(
              "[SignalWireAdapter] gated — dropping",
              event.data.byteLength,
              "bytes of agent audio"
            );
          }
          return;
        }
        if (serverSocket.readyState !== WebSocket.OPEN) return;

        const now = Date.now();
        const durationMs = (event.data.byteLength / agentBytesPerSec) * 1000;
        estimatedPlaybackEndAt =
          Math.max(now, estimatedPlaybackEndAt) + durationMs;
        const payload =
          options?.agentAudioFormat === "mulaw"
            ? arrayBufferToBase64(event.data)
            : pcm16ToSignalWireMulaw(
                new Int16Array(event.data),
                agentSampleRate
              );
        serverSocket.send(
          JSON.stringify({ event: "media", streamSid, media: { payload } })
        );
      });

      socket.addEventListener("close", () => {
        if (serverSocket.readyState === WebSocket.OPEN) serverSocket.close();
      });
      socket.send(JSON.stringify({ type: "start_call" }));
    };

    const handleCarrierMessage = async (event: MessageEvent) => {
      if (typeof event.data !== "string") return;
      let message: { event?: string };
      try {
        message = JSON.parse(event.data) as { event?: string };
      } catch {
        return;
      }

      switch (message.event) {
        case "start": {
          const start = message as SignalWireStartMessage;
          if (
            start.start.mediaFormat.encoding !== "audio/x-mulaw" ||
            start.start.mediaFormat.sampleRate !== 8000 ||
            start.start.mediaFormat.channels !== 1
          ) {
            console.error(
              "[SignalWireAdapter] Expected mono audio/x-mulaw at 8000 Hz"
            );
            serverSocket.close(1003, "Unsupported media format");
            return;
          }
          streamSid = start.start.streamSid;
          await connectToAgent(
            options?.instanceName ?? start.start.callSid ?? "default"
          );
          return;
        }
        case "media": {
          const media = message as SignalWireMediaMessage;
          if (media.media.track !== "inbound") return;
          const pcm16 = signalWireMulawToPcm16(
            media.media.payload,
            options?.sttSampleRate ?? 16000
          );

          // Preemptive duck: gate inbound audio while the agent is playing
          // TTS, so the agent never hears its own voice looping back. Only
          // let audio through if the caller is loud enough to barge in.
          const agentSpeaking =
            ECHO_GATE_ENABLED &&
            Date.now() < estimatedPlaybackEndAt + PLAYBACK_GRACE_MS;

          if (agentSpeaking) {
            const energy = meanSquaredEnergy(pcm16);
            const loud = energy > SPEECH_ENERGY_THRESHOLD;
            if (options?.debugAudio) {
              console.log("[SignalWireAdapter] duck — agentSpeaking, energy:", {
                energy: Math.round(energy),
                loud,
                loudFrames: loud ? loudFrames + 1 : 0,
                audioGated,
                playbackRemainingMs: Math.max(
                  0,
                  estimatedPlaybackEndAt + PLAYBACK_GRACE_MS - Date.now()
                )
              });
            }

            // Detect caller barge-in: sustained loud energy during playback
            // means the caller is actually speaking, not just echo.
            loudFrames = loud ? loudFrames + 1 : 0;
            if (loudFrames >= SPEECH_DEBOUNCE_FRAMES) {
              console.log("[SignalWireAdapter] BARGE-IN — caller speaking");
              audioGated = true;
              loudFrames = 0;
              sendClearAudio();
              // Forward this frame — caller is barging in
              if (agentSocket?.readyState === WebSocket.OPEN) {
                agentSocket.send(pcm16.buffer as ArrayBuffer);
              }
              return;
            }

            // No barge-in — drop this frame (echo suppression)
            return;
          }

          // Agent is silent — forward audio normally.
          if (agentSocket?.readyState === WebSocket.OPEN) {
            agentSocket.send(pcm16.buffer as ArrayBuffer);
          }
          // Without this the case falls through to `dtmf` and re-sends every
          // audio frame as a JSON media event — doubling the agent's inbound
          // WebSocket message rate (one extra Durable Object invocation per
          // 20 ms frame) for payloads it then ignores.
          return;
        }
        case "dtmf": {
          if (agentSocket?.readyState === WebSocket.OPEN) {
            agentSocket.send(JSON.stringify(message as SignalWireDtmfMessage));
          }
          return;
        }
        case "stop":
          endAgentCall();
          return;
      }
    };

    serverSocket.addEventListener("message", (event) => {
      void handleCarrierMessage(event).catch((error: unknown) => {
        console.error("[SignalWireAdapter] Carrier message failed", error);
        endAgentCall();
      });
    });
    serverSocket.addEventListener("close", endAgentCall);

    return new Response(null, { status: 101, webSocket: signalWireSocket });
  }
}

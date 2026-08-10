import {
  arrayBufferToBase64,
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
}

/** Fallback until the agent's `audio_config` announces the real TTS rate. */
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
              return;
            }
            if (message.type === "playback_interrupt") {
              if (serverSocket.readyState === WebSocket.OPEN) {
                serverSocket.send(
                  JSON.stringify({ event: "clear", streamSid })
                );
              }
              return;
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
        if (serverSocket.readyState !== WebSocket.OPEN) return;

        const payload =
          options?.agentAudioFormat === "mulaw"
            ? arrayBufferToBase64(event.data)
            : pcm16ToSignalWireMulaw(new Int16Array(event.data), agentSampleRate);
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
          if (agentSocket?.readyState === WebSocket.OPEN) {
            agentSocket.send(pcm16.buffer as ArrayBuffer);
          }
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

/**
 * SignalWire bidirectional cXML Stream adapter for the Agents voice
 * pipeline.
 *
 * Bridges SignalWire's bidirectional audio streaming WebSocket protocol to
 * VoiceAgent's binary PCM + JSON voice protocol.
 *
 * SignalWire sends base64-encoded mulaw 8kHz audio. The adapter decodes
 * mulaw and resamples 8→16kHz before forwarding to VoiceAgent. Agent PCM
 * (16kHz) is resampled back to 8kHz and mulaw-encoded before playback.
 *
 * Use codec="PCMU@8000h" in the SignalWire cXML `<Stream>`.
 */

import {
  arrayBufferToBase64,
  mulawBase64ToPcm16,
  pcm16ToMulawBase64
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

export interface SignalWireAdapterOptions {
  /**
   * Instance name for the VoiceAgent Durable Object.
   * Defaults to the SignalWire Call SID (each call gets its own agent
   * instance).
   */
  instanceName?: string;
}

/**
 * Bridges SignalWire audio streaming to a VoiceAgent Durable Object.
 */
export class SignalWireAdapter {
  /**
   * Handle an incoming SignalWire audio streaming WebSocket connection.
   * Routes the audio to a VoiceAgent Durable Object.
   */
  static handleRequest(
    request: Request,
    env: object,
    agentName: string,
    options?: SignalWireAdapterOptions
  ): Response {
    const upgradeHeader = request.headers.get("Upgrade");
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const { 0: signalWireSocket, 1: serverSocket } = new WebSocketPair();

    serverSocket.accept();

    let streamSid: string | null = null;
    let agentSocket: WebSocket | null = null;
    let agentAudio:
      | { format: "pcm16"; sampleRate: number }
      | { format: "mulaw"; sampleRate: 8000 }
      | null = { format: "pcm16", sampleRate: 16000 };

    const rejectAgentAudio = (format: unknown, sampleRate: unknown) => {
      agentAudio = null;
      console.error(
        `Unsupported agent audio config: ${String(format)}/${String(sampleRate)}`
      );
      agentSocket?.close(1003, "Unsupported agent audio format");
      serverSocket.close(1003, "Unsupported agent audio format");
    };

    const sendClearAudio = () => {
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
      const namespace = (env as Record<string, unknown>)[agentName] as
        | DurableObjectNamespace
        | undefined;
      if (!namespace) {
        console.error(
          `[SignalWireAdapter] DO namespace "${agentName}" not found in env`
        );
        return;
      }

      const id = namespace.idFromName(instanceId);
      const stub = namespace.get(id);

      const agentUrl = new URL(request.url);
      agentUrl.pathname = `/agents/${agentNameToRoutePath(agentName)}/${instanceId}`;
      agentUrl.protocol = "https:";

      const agentResp = await stub.fetch(
        new Request(agentUrl.toString(), {
          headers: { Upgrade: "websocket" }
        })
      );

      const ws = agentResp.webSocket;
      if (!ws) {
        console.error("[SignalWireAdapter] Failed to get WebSocket from agent");
        return;
      }

      ws.accept();
      // Cloudflare may deliver accepted WebSocket binary frames as Blob.
      // Normalize that at the boundary instead of dropping generated audio.
      try {
        ws.binaryType = "arraybuffer";
      } catch {
        // Some runtimes may not expose a settable binaryType.
      }
      agentSocket = ws;

      ws.addEventListener("message", async (event) => {
        if (!streamSid) return;

        if (typeof event.data === "string") {
          try {
            const msg = JSON.parse(event.data) as Record<string, unknown>;

            if (msg.type === "audio_config") {
              const format = msg.format;
              const sampleRate =
                msg.sampleRate ??
                (format === "pcm16" ? 16000 : format === "mulaw" ? 8000 : 0);
              if (
                format === "pcm16" &&
                typeof sampleRate === "number" &&
                Number.isFinite(sampleRate) &&
                sampleRate > 0
              ) {
                agentAudio = { format, sampleRate };
              } else if (format === "mulaw" && sampleRate === 8000) {
                agentAudio = { format, sampleRate };
              } else {
                rejectAgentAudio(format, sampleRate);
              }
              return;
            }

            if (msg.type === "playback_interrupt") {
              sendClearAudio();
              return;
            }

            if (
              serverSocket.readyState === WebSocket.OPEN &&
              (msg.type === "transcript" ||
                msg.type === "transcript_end" ||
                msg.type === "status")
            ) {
              serverSocket.send(
                JSON.stringify({
                  event: "mark",
                  streamSid,
                  mark: { name: JSON.stringify(msg) }
                })
              );
            }
          } catch {
            // ignore non-JSON
          }
        } else {
          const audio =
            event.data instanceof ArrayBuffer
              ? event.data
              : event.data instanceof Blob
                ? await event.data.arrayBuffer()
                : null;
          if (!audio) return;

          if (agentAudio && serverSocket.readyState === WebSocket.OPEN) {
            const payload =
              agentAudio.format === "mulaw"
                ? arrayBufferToBase64(audio)
                : pcm16ToMulawBase64(
                    new Int16Array(audio),
                    agentAudio.sampleRate
                  );
            serverSocket.send(
              JSON.stringify({
                event: "media",
                streamSid,
                media: { payload }
              })
            );
          }
        }
      });

      ws.addEventListener("close", () => {
        if (serverSocket.readyState === WebSocket.OPEN) {
          serverSocket.close();
        }
      });

      ws.send(JSON.stringify({ type: "start_call" }));
    };

    const handleCarrierMessage = async (event: MessageEvent) => {
      if (typeof event.data !== "string") return;

      let msg: { event?: string };
      try {
        msg = JSON.parse(event.data) as { event?: string };
      } catch {
        return;
      }

      switch (msg.event) {
        case "start": {
          const startMsg = msg as unknown as SignalWireStartMessage;
          if (
            startMsg.start.mediaFormat.encoding !== "audio/x-mulaw" ||
            startMsg.start.mediaFormat.sampleRate !== 8000 ||
            startMsg.start.mediaFormat.channels !== 1
          ) {
            console.error(
              "[SignalWireAdapter] Expected mono audio/x-mulaw at 8000 Hz"
            );
            serverSocket.close(1003, "Unsupported media format");
            return;
          }
          streamSid = startMsg.start.streamSid;

          const instanceId =
            options?.instanceName ?? startMsg.start.callSid ?? "default";
          await connectToAgent(instanceId);
          break;
        }

        case "media": {
          const mediaMsg = msg as unknown as SignalWireMediaMessage;
          if (mediaMsg.media.track !== "inbound") break;

          // SignalWire loops carrier playback into inbound audio. Raw-energy
          // barge-in therefore clears the agent on its own speech before STT
          // can identify the transcript as echo. Forward all caller audio and
          // let VoiceAgent's STT/VAD send playback_interrupt instead.
          const pcm16k = mulawBase64ToPcm16(mediaMsg.media.payload);
          if (agentSocket?.readyState === WebSocket.OPEN) {
            agentSocket.send(pcm16k.buffer as ArrayBuffer);
          }
          break;
        }

        case "dtmf": {
          const dtmfMsg = msg as unknown as SignalWireDtmfMessage;
          if (agentSocket?.readyState === WebSocket.OPEN) {
            agentSocket.send(JSON.stringify(dtmfMsg));
          }
          break;
        }

        case "stop":
          endAgentCall();
          break;
      }
    };

    serverSocket.addEventListener("message", (event) => {
      void handleCarrierMessage(event).catch((error: unknown) => {
        console.error("[SignalWireAdapter] Carrier message failed", error);
        endAgentCall();
      });
    });

    serverSocket.addEventListener("close", endAgentCall);

    return new Response(null, {
      status: 101,
      webSocket: signalWireSocket
    });
  }
}

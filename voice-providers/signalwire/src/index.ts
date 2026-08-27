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
import type { VoicePlaybackMarkerMessage } from "@cloudflare/voice";
import type {
  SignalWireDtmfMessage,
  SignalWireMarkMessage,
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
    let outboundFrames = 0;
    let outboundBytes = 0;
    const pendingPlaybackMarkers = new Map<
      string,
      Pick<VoicePlaybackMarkerMessage, "playbackId" | "sequence" | "text"> & {
        frames: number;
        bytes: number;
      }
    >();
    let agentMessageChain: Promise<void> = Promise.resolve();
    let nextOutboundMediaAt = 0;
    let playbackGeneration = 0;

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
      const handleAgentMessage = (event: {
        data?: unknown;
        playbackGeneration: number;
      }) => {
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

            if (msg.type === "playback_marker") {
              const sequence = msg.sequence;
              if (
                typeof msg.playbackId !== "string" ||
                typeof msg.text !== "string" ||
                typeof sequence !== "number" ||
                !Number.isInteger(sequence) ||
                sequence <= 0
              ) {
                return;
              }
              if (
                serverSocket.readyState !== WebSocket.OPEN ||
                outboundFrames === 0
              ) {
                return;
              }
              const marker: VoicePlaybackMarkerMessage = {
                type: "playback_marker",
                playbackId: msg.playbackId,
                sequence,
                text: msg.text
              };
              const markName = `playback:${marker.playbackId}:${marker.sequence}`;
              serverSocket.send(
                JSON.stringify({
                  event: "mark",
                  streamSid,
                  mark: { name: markName }
                })
              );
              pendingPlaybackMarkers.set(markName, {
                playbackId: marker.playbackId,
                sequence: marker.sequence,
                text: marker.text,
                frames: outboundFrames,
                bytes: outboundBytes
              });
              console.log("[VoiceTrace]", {
                event: "tts_sent",
                streamSid,
                playbackId: marker.playbackId,
                sequence: marker.sequence,
                text: marker.text,
                frames: outboundFrames,
                bytes: outboundBytes
              });
              outboundFrames = 0;
              outboundBytes = 0;
              return;
            }

            if (msg.type === "status" && msg.status === "speaking") {
              outboundFrames = 0;
              outboundBytes = 0;
              nextOutboundMediaAt = 0;
            }

            if (
              serverSocket.readyState === WebSocket.OPEN &&
              (msg.type === "transcript" ||
                msg.type === "transcript_end" ||
                msg.type === "status")
            ) {
              const markName = JSON.stringify(msg);
              serverSocket.send(
                JSON.stringify({
                  event: "mark",
                  streamSid,
                  mark: { name: markName }
                })
              );
            }
          } catch {
            // ignore non-JSON
          }
        } else {
          const sendAgentAudio = (audio: ArrayBuffer): Promise<void> | void => {
            if (
              !agentAudio ||
              event.playbackGeneration !== playbackGeneration
            ) {
              return;
            }
            const payload =
              agentAudio.format === "mulaw"
                ? arrayBufferToBase64(audio)
                : pcm16ToMulawBase64(
                    new Int16Array(audio),
                    agentAudio.sampleRate
                  );
            const padding = payload.endsWith("==")
              ? 2
              : payload.endsWith("=")
                ? 1
                : 0;
            const bytes = (payload.length / 4) * 3 - padding;
            const now = Date.now();
            const sendAt = Math.max(now, nextOutboundMediaAt);
            nextOutboundMediaAt = sendAt + bytes / 8;

            const send = () => {
              if (
                event.playbackGeneration !== playbackGeneration ||
                serverSocket.readyState !== WebSocket.OPEN
              ) {
                return;
              }
              serverSocket.send(
                JSON.stringify({
                  event: "media",
                  streamSid,
                  media: { payload }
                })
              );
              outboundFrames++;
              outboundBytes += bytes;
            };
            const delay = sendAt - now;
            if (delay <= 0) {
              send();
              return;
            }
            return new Promise<void>((resolve) => {
              setTimeout(resolve, delay);
            }).then(send);
          };
          if (event.data instanceof Blob) {
            return event.data.arrayBuffer().then(sendAgentAudio);
          }
          if (event.data instanceof ArrayBuffer) {
            return sendAgentAudio(event.data);
          }
        }
      };

      const agentMessageQueue: Array<{
        data?: unknown;
        playbackGeneration: number;
      }> = [];
      let agentMessageProcessing = false;
      const drainAgentMessages = () => {
        if (agentMessageProcessing) return;
        const event = agentMessageQueue.shift();
        if (!event) return;

        agentMessageProcessing = true;
        let result: Promise<void> | void;
        try {
          result = handleAgentMessage(event);
        } catch (error: unknown) {
          console.error("[SignalWireAdapter] Agent message failed", error);
          result = undefined;
        }
        if (result) {
          agentMessageChain = Promise.resolve(result).catch(
            (error: unknown) => {
              console.error("[SignalWireAdapter] Agent message failed", error);
            }
          );
          void agentMessageChain.then(() => {
            agentMessageProcessing = false;
            drainAgentMessages();
          });
        } else {
          agentMessageProcessing = false;
          drainAgentMessages();
        }
      };
      ws.addEventListener("message", (event) => {
        if (typeof event.data === "string") {
          try {
            const message = JSON.parse(event.data) as Record<string, unknown>;
            if (message.type === "playback_interrupt") {
              playbackGeneration++;
              nextOutboundMediaAt = 0;
              pendingPlaybackMarkers.clear();
              outboundFrames = 0;
              outboundBytes = 0;
              sendClearAudio();
              return;
            }
          } catch {
            // The protocol handler ignores non-JSON strings.
          }
        }
        agentMessageQueue.push({
          data: event.data,
          playbackGeneration
        });
        drainAgentMessages();
      });

      ws.addEventListener("close", () => {
        if (serverSocket.readyState === WebSocket.OPEN) {
          serverSocket.close();
        }
      });

      ws.send(JSON.stringify({ type: "start_call", playback_markers: true }));
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
          pendingPlaybackMarkers.clear();
          outboundFrames = 0;
          outboundBytes = 0;
          nextOutboundMediaAt = 0;
          playbackGeneration++;
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

          const pcm16k = mulawBase64ToPcm16(mediaMsg.media.payload);
          if (agentSocket?.readyState === WebSocket.OPEN) {
            agentSocket.send(pcm16k.buffer as ArrayBuffer);
          }
          break;
        }

        case "mark": {
          const mark = "mark" in msg ? msg.mark : undefined;
          if (
            !mark ||
            typeof mark !== "object" ||
            !("name" in mark) ||
            typeof mark.name !== "string"
          ) {
            break;
          }
          const markName: SignalWireMarkMessage["mark"]["name"] = mark.name;
          const playback = pendingPlaybackMarkers.get(markName);
          if (playback) {
            pendingPlaybackMarkers.delete(markName);
            console.log("[VoiceTrace]", {
              event: "tts_played",
              streamSid,
              playbackId: playback.playbackId,
              sequence: playback.sequence,
              text: playback.text,
              frames: playback.frames,
              bytes: playback.bytes
            });
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

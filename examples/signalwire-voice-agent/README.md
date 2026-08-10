# SignalWire Phone Voice Agent

A phone voice agent built on the Cloudflare Agents voice pipeline. Dial a SignalWire number and have a real-time conversation with an AI agent. All models run on Workers AI; no third-party AI keys are required.

## How it works

```
Caller dials SignalWire number
        ↓
SignalWire fetches /answer → returns cXML → SignalWire opens WebSocket to /signalwire
        ↓
SignalWireAdapter bridges the audio stream to MyVoiceAgent (Durable Object)
        ↓
STT: Workers AI Flux (@cf/deepgram/flux)
        ↓
LLM: Workers AI Kimi K2.6 (@cf/moonshotai/kimi-k2.6)
        ↓
TTS: Workers AI Deepgram Aura 2 (@cf/deepgram/aura-2-en, 8 kHz μ-law)
        ↓
Audio back to caller via SignalWire, unchanged (agentAudioFormat: "mulaw_8000")
```

The TTS provider asks Aura for 8 kHz μ-law directly — SignalWire's own wire
format — so `SignalWireAdapter` forwards every frame byte-for-byte instead of
resampling PCM16 to μ-law on every turn.

## Prerequisites

1. A SignalWire account with a voice-enabled phone number ([signalwire.com](https://signalwire.com))
2. A Cloudflare account with [Workers AI](https://developers.cloudflare.com/workers-ai/) access
3. Wrangler authenticated with your Cloudflare account (`npx wrangler login`)

## Setup

### 1. Install and build

From the repository root:

```bash
npm install
npm run build
```

The build compiles the workspace packages the example imports.

### 2. Deploy

```bash
cd examples/signalwire-voice-agent
npm run deploy
```

This runs `wrangler deploy` and prints the Worker's `*.workers.dev` URL.

### 3. Point the number at the Worker

In the SignalWire dashboard, open the phone number and set its **WHEN A CALL COMES IN** webhook to `https://<your-worker>.workers.dev/answer` (method `GET` or `POST`, cXML). Unlike Plivo, SignalWire calls the webhook directly — no separate application resource to create.

### 4. Call

Dial the SignalWire number. The agent greets the caller and responds in real time. Speaking over the agent interrupts playback.

## Local development

```bash
npm run dev
```

SignalWire's cloud can't reach localhost. Expose the dev server with a tunnel, e.g. [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/):

```bash
cloudflared tunnel --url http://localhost:8787
```

Point the number's webhook at `<tunnel-url>/answer` while developing, then switch it back to the deployed Worker's URL afterward.

## Securing the stream URL

SignalWire stream URLs don't support query parameters. For production, add an
`authBearerToken` to the `<Stream>` element in `/answer` and validate the
`Authorization` header on `/signalwire` before calling
`SignalWireAdapter.handleRequest` — see the
[`@cloudflare/voice-signalwire` README](../../voice-providers/signalwire/README.md#authentication).

## Related examples

- [`examples/plivo-voice-agent`](../plivo-voice-agent) — same pattern over Plivo's Media Streams.
- [`examples/telnyx-voice-agent`](../telnyx-voice-agent) — same pattern over Telnyx Call Control.
- [`examples/voice-agent-webrtc`](../voice-agent-webrtc) — browser-based voice agent.

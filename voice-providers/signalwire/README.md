# @cloudflare/voice-signalwire

SignalWire bidirectional cXML Stream adapter for the Cloudflare Agents voice pipeline.

```text
Caller → SignalWire PCMU/8 kHz → SignalWireAdapter → PCM16/16 kHz → VoiceAgent
Caller ← SignalWire PCMU/8 kHz ← SignalWireAdapter ← PCM16/16 kHz ← VoiceAgent
```

## Usage

```ts
import { Agent, routeAgentRequest } from "agents";
import { withVoice, type TTSProvider } from "@cloudflare/voice";
import { SignalWireAdapter } from "@cloudflare/voice-signalwire";

// WorkersAITTS defaults to MP3, which the adapter's mulaw encoder can't
// consume. Call @cf/deepgram/aura-2-en directly for raw linear16 PCM.
class SignalWirePCMTTS implements TTSProvider {
  constructor(private ai: Ai) {}

  async synthesize(text: string, signal?: AbortSignal) {
    const response = (await this.ai.run(
      "@cf/deepgram/aura-2-en",
      {
        text,
        speaker: "asteria",
        encoding: "linear16",
        sample_rate: 16000,
        container: "none"
      },
      { returnRawResponse: true, ...(signal ? { signal } : {}) }
    )) as Response;
    if (!response.ok) return null;
    return response.arrayBuffer();
  }
}

const VoiceAgent = withVoice(Agent);

export class MyAgent extends VoiceAgent<Env> {
  tts = new SignalWirePCMTTS(this.env.AI);

  async onTurn() {
    return "Hello. How can I help?";
  }
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);

    if (url.pathname === "/answer") {
      const streamUrl = `wss://${url.host}/signalwire`;
      return new Response(
        `<Response><Connect><Stream url="${streamUrl}" codec="PCMU@8000h" realtime="true" /></Connect></Response>`,
        { headers: { "Content-Type": "application/xml" } }
      );
    }

    if (url.pathname === "/signalwire") {
      return SignalWireAdapter.handleRequest(request, env, "MyAgent");
    }

    return (
      (await routeAgentRequest(request, env)) ??
      new Response("Not found", { status: 404 })
    );
  }
};
```

Point the SignalWire phone number's **WHEN A CALL COMES IN** webhook at
`https://your-worker.workers.dev/answer`.

## Audio contract

The stream must use mono `PCMU@8000h`. The adapter decodes inbound audio and
resamples 8→16 kHz PCM16 for VoiceAgent, and resamples outbound VoiceAgent
PCM16 (16 kHz) back to 8 kHz mulaw for SignalWire. Both rates are fixed —
there is no dynamic format negotiation.

Configure a TTS provider that returns raw signed 16-bit little-endian PCM at
16 kHz, as shown above.

## Barge-in and echo suppression

SignalWire can loop carrier playback into inbound audio, so the adapter does
not use raw inbound energy to clear playback: that would cut off the agent on
its own voice. Inbound audio always reaches VoiceAgent, whose STT/VAD sends a
`playback_interrupt` when it detects caller speech. The adapter translates
that ordered event to SignalWire's `clear` event.

SignalWire stream URLs do not support query parameters. Use the `<Stream
authBearerToken="...">` attribute when creating cXML and validate its
`Authorization` header before calling `SignalWireAdapter.handleRequest`.

## Options

```ts
SignalWireAdapter.handleRequest(request, env, "MyAgent", {
  instanceName: "shared-agent"
});
```

Without `instanceName`, each SignalWire Call SID maps to a separate Durable
Object instance.

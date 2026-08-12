# @cloudflare/voice-signalwire

SignalWire bidirectional cXML Stream adapter for the Cloudflare Agents voice pipeline.

```text
Caller → SignalWire PCMU/8 kHz → SignalWireAdapter → PCM16/agentSampleRate → VoiceAgent
Caller ← SignalWire PCMU/8 kHz ← SignalWireAdapter ← PCM16/agentSampleRate → VoiceAgent
```

## Usage

```ts
import { Agent, routeAgentRequest } from "agents";
import { withVoice } from "@cloudflare/voice";
import { SignalWireAdapter } from "@cloudflare/voice-signalwire";

const VoiceAgent = withVoice(Agent, { audioFormat: "pcm16" });

export class MyAgent extends VoiceAgent<Env> {
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

The stream must use mono `PCMU@8000h`. The adapter converts inbound audio to
raw mono PCM16 at `sttSampleRate` for VoiceAgent, and converts outbound
VoiceAgent PCM16 back to SignalWire PCMU.

The default `WorkersAITTS` emits MP3 and is not compatible. Configure a TTS
provider that returns raw signed 16-bit little-endian PCM at the same rate.

`WorkersAIRealtimeTTS` defaults to 8 kHz μ-law — its `sampleRate` reaches the
bridge through the agent's `audio_config`, and `agentAudioFormat: "mulaw"` (see
Options) forwards those bytes verbatim. Running STT at 8 kHz too removes
resampling from both directions:

```ts
const VoiceAgent = withVoice(Agent);

class MyAgent extends VoiceAgent<Env> {
  transcriber = new WorkersAIFluxSTT(this.env.AI, { sampleRate: 8000 });
  tts = new WorkersAIRealtimeTTS(this.env.AI);
}
```

## Barge-in and echo suppression

The adapter uses an energy-based gate to prevent the agent from hearing its
own TTS looped back through the phone trunk. When the agent is playing audio
and the inbound energy exceeds the speech threshold for three consecutive
frames, the adapter sends SignalWire's `clear` event and gates outbound agent
audio until the next turn boundary. This also handles caller barge-in — the
gate cannot distinguish echo from real caller speech, and doesn't need to.

Agent-side STT/VAD drives `playback_interrupt` as a secondary path for speech
that falls below the local energy threshold.

SignalWire stream URLs do not support query parameters. Use the `<Stream
 authBearerToken="...">` attribute when creating cXML and validate its
`Authorization` header before calling `SignalWireAdapter.handleRequest`.

## Options

```ts
SignalWireAdapter.handleRequest(request, env, "MyAgent", {
  instanceName: "shared-agent",
  agentAudioFormat: "pcm16",
  sttSampleRate: 8000
});
```

Without `instanceName`, each SignalWire Call SID maps to a separate Durable
Object instance.

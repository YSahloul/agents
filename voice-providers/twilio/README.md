# @cloudflare/voice-twilio

Twilio Media Streams adapter for the [Cloudflare Agents](https://github.com/cloudflare/agents) voice pipeline. Connects phone calls to your `VoiceAgent` — the same agent that handles web voice, text chat, and email can now answer the phone.

## How it works

```
Phone call → Twilio → Media Streams WebSocket → TwilioAdapter → VoiceAgent (Durable Object)
                                                                    ↓
                                                              STT → LLM → TTS
                                                                    ↓
Phone speaker ← Twilio ← mulaw 8kHz audio ← TwilioAdapter ← negotiated TTS audio
```

The adapter converts Twilio's μ-law/8 kHz carrier stream to the VoiceAgent
protocol and negotiates outbound audio from the configured TTS provider.

## Install

```bash
npm install @cloudflare/voice-twilio
```

## Usage

### 1. Add the adapter to your Worker

```typescript
import { Agent, routeAgentRequest } from "agents";
import { withVoice, type VoiceTurnContext } from "@cloudflare/voice";
import { TwilioAdapter } from "@cloudflare/voice-twilio";

const VoiceAgent = withVoice(Agent);

export class MyAgent extends VoiceAgent<Env> {
  async onTurn(transcript: string, context: VoiceTurnContext) {
    // Same agent handles both web and phone calls
    return "Hello! How can I help you?";
  }
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);

    // Twilio sends WebSocket connections to this path
    if (url.pathname === "/twilio") {
      return TwilioAdapter.handleRequest(request, env, "MyAgent");
    }

    // Normal agent routing for web clients
    return (
      (await routeAgentRequest(request, env)) ??
      new Response("Not found", { status: 404 })
    );
  }
};
```

### 2. Configure Twilio

In your Twilio console, set up a TwiML Bin or webhook that streams media to your Worker:

```xml
<Response>
  <Connect>
    <Stream url="wss://your-worker.your-account.workers.dev/twilio" />
  </Connect>
</Response>
```

### 3. Assign a phone number

Attach the TwiML to a Twilio phone number. When someone calls that number, Twilio streams the audio to your Worker, which routes it to your VoiceAgent.

## Options

```typescript
TwilioAdapter.handleRequest(request, env, "MyAgent", {
  // Use a custom instance name instead of the Twilio Call SID
  instanceName: "shared-agent"
});
```

By default, each phone call creates a new VoiceAgent instance (using the Twilio Call SID as the instance name). Set `instanceName` to route multiple calls to the same agent instance.

## TTS output format

VoiceAgent announces the TTS provider's output contract before sending audio.
The adapter:

- resamples declared PCM16 from any positive sample rate to 8 kHz and encodes it
  as μ-law;
- forwards declared μ-law/8 kHz bytes unchanged;
- rejects MP3, Opus, WAV, unknown formats, and μ-law at rates other than 8 kHz.

Configure the format on the TTS provider. No adapter audio option is required.
For example, direct ElevenLabs phone audio uses `outputFormat: "pcm_16000"`;
`WorkersAIGrokTTS` works with its declared PCM16/24 kHz default.

## Same agent, every channel

The same `VoiceAgent` instance can handle:

- **Web voice** via `VoiceClient` / `useVoiceAgent`
- **Phone calls** via this Twilio adapter
- **Text chat** via `sendText()`
- **Email** via `routeAgentEmail()`

All channels share the same conversation history (SQLite), state, tools, and scheduling.

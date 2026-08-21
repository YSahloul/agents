# SignalWire Think Phone Agent

A phone voice agent that uses SignalWire for PSTN audio and the public `@cloudflare/think/voice` adapter for one Durable Object that owns Voice ingress, TTS, model turns, and Think Session persistence.

## How it works

```text
Caller
  → SignalWire media WebSocket
  → SignalWireAdapter
  → MyThinkAgent (createVoiceThink + voiceChannel)
  → Think Session (channel: "voice")
  → TTS audio
  → detached retail_agent calls
  → retained RetailAgent instances and retail MCP tools
```

`MyThinkAgent` is the only active Durable Object binding. `createVoiceThink()` composes the Voice protocol with Think, so the same object receives Voice frames and Think chat frames, persists the conversation in Think Session, and propagates the Voice abort signal directly into `runTurn()`. Voice history remains transient; `cf_voice_messages` is not created.

The `voiceChannel()` definition supplies the Flux transcriber, SignalWire PCM TTS provider, and live-speech instructions. `deliverNotice({ channel: "voice" })` speaks an in-turn notice without ending the model turn and speaks an out-of-turn notice to live calls.

`MyThinkAgent` also exposes one `retail_agent` orchestration tool. Each call starts a retained `RetailAgent` with `runAgentTool(..., { detached: { notify: true } })` and returns immediately, so independent searches can run concurrently while the caller continues speaking.

## Run

From the repository root:

```bash
pnpm install
pnpm run build
cd examples/signalwire-think-voice-agent
pnpm run deploy
```

Point the SignalWire number's **WHEN A CALL COMES IN** webhook at:

```text
https://<worker>.workers.dev/answer
```

Dial the number. SignalWire fetches `/answer`, opens the `/signalwire` media stream, and the agent greets the caller.

## Key adapter

```ts
const VoiceThink = createVoiceThink<Env>();

class MyThinkAgent extends VoiceThink {
  configureChannels() {
    return {
      voice: voiceChannel({
        transcriber: new WorkersAIFluxSTT(this.env.AI),
        tts: new SignalWirePCMTTS(this.env.AI),
        instructions: "Answer in one short sentence for live speech."
      })
    };
  }
}
```

`SignalWireAdapter.handleRequest(request, env, "MyThinkAgent")` routes media into that same Think Durable Object. No cross-DO RPC bridge or manual `cancelChat()` call is required.

## Local development

```bash
pnpm run dev
```

SignalWire cannot reach localhost directly. Expose port `8787` through a tunnel and point the number at `<tunnel-url>/answer`.

## Related examples

- [`examples/signalwire-voice-agent`](../signalwire-voice-agent) — direct Voice Agent without Think.
- [`examples/signalwire-mcp-voice-agent`](../signalwire-mcp-voice-agent) — direct Voice Agent with MCP tools.
- [`examples/voice-agent-webrtc`](../voice-agent-webrtc) — browser WebRTC voice transport.

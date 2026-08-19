# SignalWire Think Phone Agent

A phone voice agent that uses SignalWire for PSTN audio, `@cloudflare/voice` for speech, and a separate `Think` Durable Object for the conversation. The Think agent is a tire-and-wheel sales and customer-service agent that calls the retail MCP server's tools directly.

## How it works

```text
Caller
  → SignalWire media WebSocket
  → SignalWireAdapter
  → MyVoiceAgent (STT and TTS)
  → streamRpcVoiceTurn()
  → MyThinkAgent (model, prompt, persistent conversation)
  → retail MCP tools (tire/wheel search, inventory, pricing, fitment)
```

`MyVoiceAgent` and `MyThinkAgent` use the same instance name, so each phone call is routed to its corresponding Think conversation. Aborting a voice turn forwards the Think request ID to `cancelChat()`.

`MyThinkAgent` connects to the retail MCP server in `onStart()` via `addMcpServer("retail", …)`. Think's `includeMcpTools` default (`true`) auto-merges the server's discovered tools into every model turn, so the model calls them directly — no sub-agent and no hardcoded tool names or schemas.

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

Ask, "Find two 20-by-9 wheels," or "Which tires fit an 18-inch wheel?" to exercise the Think → MCP tool path.

## Local development

```bash
pnpm run dev
```

SignalWire cannot reach localhost directly. Expose port `8787` through a tunnel and point the number at `<tunnel-url>/answer`.

## Key bridge

```ts
const brain = await getAgentByName(this.env.MyThinkAgent, this.name);

return streamRpcVoiceTurn({
  signal: context.signal,
  run: (callback) => brain.runVoiceTurn(transcript, callback),
  cancel: (requestId, reason) => brain.cancelChat(requestId, reason)
});
```

`runVoiceTurn()` selects Think's `voice` channel, whose per-channel instructions keep replies short and speakable without changing the SignalWire transport.

The phone transport remains SignalWire's media WebSocket. Think receives text over Durable Object RPC; it does not depend on WebRTC.

## Related examples

- [`examples/signalwire-voice-agent`](../signalwire-voice-agent) — direct Voice Agent without Think.
- [`examples/signalwire-mcp-voice-agent`](../signalwire-mcp-voice-agent) — direct Voice Agent with MCP tools.
- [`examples/voice-agent-webrtc`](../voice-agent-webrtc) — the same Think RPC bridge over browser WebRTC audio.

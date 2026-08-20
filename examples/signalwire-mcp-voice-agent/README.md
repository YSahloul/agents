# SignalWire MCP Voice Agent

A separate SignalWire phone agent that discovers and calls tools from both its test MCP server and the Wheel Pros retail MCP server before speaking the result. It leaves the standard SignalWire voice example unchanged.

## How it works

The Worker exposes a stateless test MCP server at `/mcp`. `MyVoiceAgent.onStart()` connects to that endpoint and `https://wpros-mcp.agenticflows.workers.dev/retail/mcp` with `addMcpServer()`. `onTurn()` passes every executable tool discovered by `this.mcp.getAITools()` to GLM 4.7 Flash. Reasoning is disabled so tool calls and the final spoken answer stream without a thinking phase.

The local endpoint provides `get_current_time`. The retail server provides product-card, product-image, wheel, tire, and accessory tools. Ask, "What time is it?" or "Find two 20-by-9 wheels" to exercise MCP discovery, execution, and the spoken follow-up response.

## Run locally

From the repository root:

```bash
pnpm install
pnpm run build
cd examples/signalwire-mcp-voice-agent
pnpm run dev
```

The configured MCP URLs point at the deployed test and retail Workers. Override `MCP_SERVER_URL` or `RETAIL_MCP_SERVER_URL` to use different MCP endpoints.

## Deploy

```bash
pnpm run deploy
```

Point a SignalWire number's incoming-call webhook at:

```text
https://signalwire-mcp-voice-agent-consolidation-test.<your-subdomain>.workers.dev/answer
```

The original `signalwire-voice-agent-example` Worker and its number do not need to change; this uses a separate test Worker and SignalWire number.

## Related examples

- [`signalwire-voice-agent`](../signalwire-voice-agent) — phone voice agent without MCP tools.
- [`mcp-worker`](../mcp-worker) — minimal stateless MCP server.
- [`mcp-client`](../mcp-client) — dynamic MCP client and OAuth flows.

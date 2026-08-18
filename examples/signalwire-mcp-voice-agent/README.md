# SignalWire MCP Voice Agent

A separate SignalWire phone agent that discovers and calls tools from both its test MCP server and the Wheel Pros retail MCP server before speaking the result. It leaves the standard SignalWire voice example unchanged.

## How it works

Per-business config (system prompt, model, and the two MCP server URLs) lives in a D1 table (`agent_configs`), keyed by the SignalWire number the caller dialed. `SignalWireAdapter`'s `resolveProps` hook queries that table by the `To` number forwarded in the cXML `<Stream>` and delivers the row to the agent DO via `getAgentByName(..., { props })`. `MyVoiceAgent.onStart(props)` reads `this.callProps` and connects to the resolved (or `MCP_SERVER_URL`/`RETAIL_MCP_SERVER_URL` fallback) endpoints with `addMcpServer()`. `onTurn()` reads `this.callProps.systemPrompt`/`.model` (falling back to the module defaults) and passes every tool discovered by `this.mcp.getAITools()` to the model. Reasoning is disabled so tool calls and the final spoken answer stream without a thinking phase.

The local endpoint provides `get_current_time`. The retail server provides product-card, product-image, wheel, tire, and accessory tools. Ask, "What time is it?" or "Find two 20-by-9 wheels" to exercise MCP discovery, execution, and the spoken follow-up response.

## Run locally

From the repository root:

```bash
pnpm install
pnpm run build
cd examples/signalwire-mcp-voice-agent
pnpm exec wrangler d1 migrations apply signalwire-mcp-voice-agent-db --local
pnpm exec wrangler d1 execute signalwire-mcp-voice-agent-db --local --command \
  "INSERT INTO agent_configs (phone_number, system_prompt, model, mcp_server_url, retail_mcp_server_url) VALUES ('+15555550100', 'Your business prompt', '@cf/meta/llama-4-scout-17b-16e-instruct', 'https://your-mcp.example.com/mcp', 'https://your-retail-mcp.example.com/retail/mcp')"
pnpm run dev
```

Calls to a number with no matching `agent_configs` row fall back to the `MCP_SERVER_URL`/`RETAIL_MCP_SERVER_URL` vars and the module-level default system prompt/model.

## Deploy

```bash
pnpm exec wrangler d1 migrations apply signalwire-mcp-voice-agent-db --remote
pnpm run deploy
```

Point a SignalWire number's incoming-call webhook at:

```text
https://signalwire-mcp-voice-agent-example.<your-subdomain>.workers.dev/answer
```

The original `signalwire-voice-agent-example` Worker and its number do not need to change.

## Related examples

- [`signalwire-voice-agent`](../signalwire-voice-agent) — phone voice agent without MCP tools.
- [`mcp-worker`](../mcp-worker) — minimal stateless MCP server.
- [`mcp-client`](../mcp-client) — dynamic MCP client and OAuth flows.

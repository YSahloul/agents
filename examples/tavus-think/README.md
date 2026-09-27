# Avatar Think

A React app that compares Tavus and Anam avatars backed by the same persistent `@cloudflare/think` agent and OpenAI-compatible streaming endpoint.

## Configure Tavus

Create a Tavus PAL whose custom LLM uses this Worker's deployed URL. `base_url` must omit `/chat/completions`:

```json
{
  "layers": {
    "llm": {
      "model": "think",
      "base_url": "https://tavus-think.<account>.workers.dev/v1",
      "api_key": "<TAVUS_LLM_API_KEY>",
      "speculative_inference": false
    }
  }
}
```

Set `TAVUS_API_KEY`, `TAVUS_PAL_ID`, and `TAVUS_LLM_API_KEY`.

## Configure Anam

Register the deployed Worker as an Anam custom LLM. Unlike Tavus, Anam requires the full endpoint URL:

```bash
curl -X POST https://api.anam.ai/v1/llms \
  -H "Authorization: Bearer $ANAM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "displayName": "Cloudflare Think",
    "urls": [{"url": "https://tavus-think.<account>.workers.dev/v1/chat/completions"}],
    "llmFormat": "openai",
    "modelName": "think",
    "secret": "<ANAM_LLM_API_KEY>"
  }'
```

Set:

- `ANAM_API_KEY`: server-side Anam API key.
- `ANAM_AVATAR_ID`: avatar selected or created in Anam Lab.
- `ANAM_VOICE_ID`: voice selected in Anam Lab.
- `ANAM_LLM_ID`: `id` returned by the custom LLM request.
- `ANAM_LLM_API_KEY`: random shared secret supplied as `secret` above.

The Worker puts a unique Think session marker in each Anam system prompt. Anam's authorized endpoint probes get isolated temporary Think sessions instead of sharing conversation history.

## Run

```bash
pnpm install
cp .env.example .dev.vars
pnpm run start
```

Open `/` for Tavus or `/anam` for Anam. Tavus embeds its hosted conversation. Anam exchanges the server-only API key for a short-lived token, then connects the browser directly over WebRTC.

Set the same variables as production secrets before deployment:

```bash
pnpm exec wrangler secret put TAVUS_API_KEY
pnpm exec wrangler secret put TAVUS_PAL_ID
pnpm exec wrangler secret put TAVUS_LLM_API_KEY
pnpm exec wrangler secret put ANAM_API_KEY
pnpm exec wrangler secret put ANAM_AVATAR_ID
pnpm exec wrangler secret put ANAM_VOICE_ID
pnpm exec wrangler secret put ANAM_LLM_ID
pnpm exec wrangler secret put ANAM_LLM_API_KEY
pnpm run deploy
```

Before deploying publicly, protect both conversation-creation routes with your application's authentication and abuse controls; starting avatar sessions can incur usage.

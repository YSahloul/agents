# Avatar WebRTC Voice Agent

A Think agent that uses a separate `@cloudflare/voice` Durable Object as its
WebRTC audio gateway. Think owns the transcript, model, tools, memory, and
workspace; Voice only handles STT, TTS, and Cloudflare Realtime SFU transport.

The demo also dispatches the same retained Researcher sub-agent used by the
`agents-as-tools` example. Its live status and final summary appear beside the
voice transcript.

The browser shows a local robot animation inspired by Pipecat's simple chatbot:
an idle image while waiting and a short frame loop while the agent speaks.
Only audio travels through the SFU; the avatar assets stay client-side.

## Run it

```bash
pnpm install
cp .env.example .env
pnpm run start
```

Deploying creates the separate `avatar-webrtc-voice` Worker and corresponding
`avatar-webrtc-voice.<account-subdomain>.workers.dev` hostname.

Set the required Realtime SFU credentials in `.env`:

```bash
REALTIME_SFU_APP_ID=...
REALTIME_SFU_BEARER_TOKEN=...
```

Workers AI provides Flux turn detection, realtime Aura TTS, and the selectable
LLM models.

## Key pattern

`MyVoiceAgent` is directly routed so the Voice WebSocket lifecycle stays on one
Durable Object. Each confirmed transcript is delegated by RPC to the
same-named `MyThinkAgent`:

```ts
const VoiceAgent = withSFUVoice(Agent);

export class MyVoiceAgent extends VoiceAgent<Env> {
  async onTurn(transcript: string, context: VoiceTurnContext) {
    const brain = await getAgentByName(this.env.MyThinkAgent, this.name);
    return streamRpcVoiceTurn({
      signal: context.signal,
      run: (callback) =>
        brain.runVoiceTurn(crypto.randomUUID(), transcript, callback, {
          model: "@cf/moonshotai/kimi-k2.7-code"
        }),
      cancel: (requestId, reason) => brain.cancelChat(requestId, reason)
    });
  }
}
```

The Think agent remains the canonical conversation:

```ts
export class MyThinkAgent extends Think<Env> {
  getModel() {
    return "@cf/moonshotai/kimi-k2.7-code";
  }

  getSystemPrompt() {
    return SYSTEM_PROMPT;
  }

  workspaceBash = false;
}
```

`runVoiceTurn()` starts `Think.chat()` with the library-provided RPC callback.
`streamRpcVoiceTurn()` returns its async text stream immediately, so Voice can
synthesize and send the first complete sentence over WebRTC while Think
continues the turn. It also forwards barge-in to `cancelChat()` after Think
exposes the request id.

The Think-provided workspace tools let voice turns create, read, update, search,
and delete durable files. Shell execution stays disabled.

`MyThinkAgent.getTools()` exposes a detached `runAgentTool(Researcher, ...)`.
The React client opens a second, same-session connection to `MyThinkAgent` and
folds its unbound `agent-tool-event` frames with `useAgentToolEvents()`, making
the helper's background progress visible while Voice continues accepting turns.

The copied `web_search` tool is simulated: it proves background orchestration,
not grounded internet research.

`[ThinkTrace]` worker logs record turn timing, step usage, and each server-side
tool call, input, result, and duration. Reasoning text remains hidden.

The Voice agent does not replay its transient `VoiceTurnContext.messages` into
Think. This prevents duplicate history. Eager end-of-turn speculation is also
disabled so provisional transcripts cannot start tool calls.

The React client gives `useVoiceAgent` the library-owned WebRTC audio input:

```tsx
const audioInput = useMemo(
  () =>
    new SFUVoiceAudioInput({
      endpoint: `/agents/my-voice-agent/${sessionId}/voice`
    }),
  [sessionId]
);

const voice = useVoiceAgent({
  agent: "my-voice-agent",
  name: sessionId,
  audioInput
});
```

There is no PCM-over-WebSocket fallback or example-owned SFU implementation.

The robot frames are adapted from
[`pipecat-ai/pipecat-examples`](https://github.com/pipecat-ai/pipecat-examples/tree/main/simple-chatbot/server/assets)
under the BSD 2-Clause License.

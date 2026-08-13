# Think WebRTC Voice Agent

A Think agent that uses a separate `@cloudflare/voice` Durable Object as its
WebRTC audio gateway. Think owns the transcript, model, tools, memory, and
workspace; Voice only handles STT, TTS, and Cloudflare Realtime SFU transport.

## Run it

```bash
pnpm install
cp .env.example .env
pnpm run start
```

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
    const callback = new VoiceReplyCallback(/* register request for abort */);
    const completion = brain.runVoiceTurn(
      crypto.randomUUID(),
      transcript,
      callback,
      { model: "@cf/moonshotai/kimi-k2.7-code" }
    );
    return streamVoiceReply(callback, completion);
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

`runVoiceTurn()` starts `Think.chat()` with an RPC callback. `MyVoiceAgent`
returns the callback's async text stream immediately, so Voice can synthesize
and send the first complete sentence over WebRTC while Think continues the
turn. The callback also exposes Think's request id so barge-in can call
`cancelChat()`.

The Think-provided workspace tools let voice turns create, read, update, search,
and delete durable files. Shell execution stays disabled.

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

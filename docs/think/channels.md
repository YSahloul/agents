# Channels

> **Experimental.** The API surface may evolve before Think graduates out of
> experimental.

A channel is a surface a Think agent talks over: the browser WebSocket, a
messenger webhook, voice, or a custom transport. Channels apply per-channel
policy and route notices without starting a model turn. Every Think agent has
an implicit `web` channel; declare additional channels with
`configureChannels()`.

## Configure channels

```typescript
import { Think, messengerChannel } from "@cloudflare/think";
import { telegram } from "@chat-adapter/telegram";

export class Assistant extends Think<Env> {
  configureChannels() {
    return {
      web: {
        kind: "web",
        ingress: { transport: "websocket" },
        instructions: "Use markdown freely in the browser."
      },
      telegram: messengerChannel(
        telegram({
          /* adapter config */
        })
      )
    };
  }
}
```

A `ChannelDefinition` contains `kind`, `ingress`, optional `capabilities`,
`instructions`, `tools`, `maxTurns`, `conversation`, and `delivery` policy.
`messengerChannel()` wraps a Chat SDK adapter as a messenger channel.

## Voice channel

Use the published `@cloudflare/think/voice` adapter when one Durable Object
should own Voice ingress, model turns, TTS, interruption handling, and Think
Session persistence. Install the optional peer:

```bash
pnpm add @cloudflare/think @cloudflare/voice
```

```typescript
import { createVoiceThink, voiceChannel } from "@cloudflare/think/voice";
import { WorkersAIFluxSTT, WorkersAITTS } from "@cloudflare/voice";

const VoiceThink = createVoiceThink<Env>({
  filterEchoedTranscripts: true,
  listenDuringCallStart: false
});

export class Assistant extends VoiceThink {
  configureChannels() {
    return {
      voice: voiceChannel({
        transcriber: new WorkersAIFluxSTT(this.env.AI),
        tts: new WorkersAITTS(this.env.AI),
        instructions: "Keep replies short and speakable. Do not use markdown."
      })
    };
  }
}
```

`@cloudflare/voice` is an optional peer of `@cloudflare/think`; ordinary Think
imports do not load it. `voiceChannel()` supplies the fixed Voice kind,
ingress, and streaming capability and requires a transcriber and TTS provider.
`createVoiceThink()` defaults to channel id `"voice"`; pass `{ channel: "phone" }`
for another configured id. It always sets `persistMessages: false`, so Think
Session is the durable source of truth and `cf_voice_messages` is not created.
The channel id is stamped onto Think's user message and shared by Voice turns
and `runTurn({ channel: "voice" })`.

### SFU WebRTC voice

For browser WebRTC audio through Cloudflare Realtime SFU, use
`createSFUVoiceThink()`. It fixes Voice audio to 24 kHz PCM16 and adds the
SFU routes to the same Durable Object as Think Session state:

```typescript
import { createSFUVoiceThink, voiceChannel } from "@cloudflare/think/voice";
import {
  WorkersAIFluxSTT,
  WorkersAITTS,
  type SFUConfig
} from "@cloudflare/voice";

const VoiceThink = createSFUVoiceThink<Env>();

export class Assistant extends VoiceThink {
  getSFUConfig(): SFUConfig {
    return {
      appId: this.env.REALTIME_SFU_APP_ID,
      apiToken: this.env.REALTIME_SFU_BEARER_TOKEN
    };
  }

  configureChannels() {
    return {
      voice: voiceChannel({
        transcriber: new WorkersAIFluxSTT(this.env.AI),
        tts: new WorkersAITTS(this.env.AI),
        instructions: "Keep replies short and speakable."
      })
    };
  }
}
```

The inherited Voice pipeline admits each transcript with
`runTurn({ channel: "voice", mode: "stream" })`, streams TTS through SFU, and
passes the Voice abort signal directly to Think. The browser, SFU routes,
Voice pipeline, Think turn, and Session therefore use one Durable Object. Use
`getVoiceTurnMetadata()` to stamp connection-specific model settings onto the
durable user message before `beforeTurn()` resolves the model.

## Channel kinds

| Kind        | Ingress                      | Notes                                            |
| ----------- | ---------------------------- | ------------------------------------------------ |
| `web`       | `{ transport: "websocket" }` | Always present.                                  |
| `messenger` | webhook                      | Fed into the existing messenger runtime.         |
| `voice`     | `{ transport: "voice" }`     | Use `@cloudflare/think/voice` for live delivery. |
| `custom`    | app-defined                  | Provide a delivery hook in a Think subclass.     |

## Per-channel policy

`instructions` is prepended to the system prompt, `tools` narrows the assembled
tool set, and `maxTurns` caps model steps. These are overridable defaults before
`beforeTurn()` runs.

Pass `channel` to `runTurn()` or `chat()` to select a channel:

```typescript
await this.runTurn({ input: "Read this out loud", channel: "voice" });
```

Inside a turn, `this.activeChannel` exposes the resolved `ChannelContext`.

## Deliver out of band

`deliverNotice()` is safe inside a tool and never opens a model turn:

```typescript
await this.deliverNotice("Your export is ready.", {
  channel: "voice",
  informModel: true
});
```

With the Think Voice adapter, an active-turn notice is inserted as a text
boundary and spoken once without cancelling the final answer. During an idle
live call, the notice is spoken through `speakAll()` to all active Voice
connections. Async iterable notices are collected into one utterance. With no
live call, delivery throws rather than silently dropping the notice.

For `web`, notices append to the transcript. Messenger notices use their
provider surface and may require `thread` for out-of-turn delivery. Custom
adapters can override the protected
`resolveChannelDeliverySurface(channelId, thread)` hook.

```typescript
type DeliverNoticeOptions = {
  channel?: string;
  informModel?: boolean;
  kind?: "final" | "interim" | "notice" | "command";
  thread?: string;
};
```

## Relationship to messengers

`configureChannels()` does not replace `getMessengers()`. Each messenger entry
becomes a messenger channel and keeps existing webhook, thread, delivery, and
recovery behavior.

## Reference

| Member                          | Description                                       |
| ------------------------------- | ------------------------------------------------- |
| `configureChannels()`           | Return the channel map.                           |
| `deliverNotice(text, options?)` | Deliver without opening a model turn.             |
| `activeChannel`                 | Current turn's channel context.                   |
| `messengerChannel(definition)`  | Wrap a Chat SDK adapter.                          |
| `createVoiceThink(options?)`    | Build a Think + Voice Durable Object constructor. |
| `voiceChannel(options)`         | Supply Voice providers and channel policy.        |

## Related

- [Messengers](./messengers.md) — Chat SDK webhook setup.
- [Actions](./actions.md) — reply attachments and notices.

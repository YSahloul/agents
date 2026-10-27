# Voice — `agents/voice`

The voice pipeline lives in `packages/agents/src/voice/` (upstream #2225).
`packages/voice` (`@cloudflare/voice`) is only a compatibility re-export.

## Source layout (`packages/agents/src/voice/`)

Same files as upstream; fork-only files are marked.

- `index.ts` — the `withVoice` mixin: the full pipeline (STT → LLM `onTurn` →
  TTS), interrupt handling, the WS protocol, the TTS dispatcher, and the public
  exports.
- `voice-input.ts` — `withVoiceInput`: STT-only variant.
- `workers-ai.ts` — `WorkersAITTS`, `WorkersAIFluxSTT`, `WorkersAINova3STT`,
  plus fork-only `WorkersAIRealtimeTTS`, `WorkersAIGrokTTS`.
- `types.ts` — provider interfaces and protocol types.
- `sfu.ts` — SFU helpers. `client.ts`, `react.tsx` — browser client and hooks.
- `audio-pipeline.ts`, `sentence-chunker.ts`, `text-stream.ts` — internals.
- Fork-only: `sfu-transport.ts`, `sfu-voice.ts` (`withSFUVoiceTransport`),
  `sfu-voice-client.ts`, `rpc-voice.ts`, `audio-converters.ts`,
  `voice-interruption.ts`. These import from `./index` with `import type` only,
  so there is no runtime cycle.

## TTS providers — the three shapes (read before touching TTS)

One job (text → audio), three provider interfaces:

| Interface                  | Method                   | Capability                              | Built-in implementor                       |
| -------------------------- | ------------------------ | --------------------------------------- | ------------------------------------------ |
| `TTSProvider`              | `synthesize(text)`       | Batch whole-sentence blob               | `WorkersAITTS`                             |
| `StreamingTTSProvider`     | `synthesizeStream(text)` | Audio stream for one speech-ready chunk | `WorkersAIRealtimeTTS`, external providers |
| `StreamingTextTTSProvider` | `synthesizeTextStream()` | Model text deltas → audio stream        | `WorkersAIGrokTTS`                         |

### Dispatcher precedence

`index.ts` sends model text deltas directly when
`typeof tts.synthesizeTextStream === "function"`. Otherwise it completes a
speech-ready chunk with `SentenceChunker`, then selects `synthesizeStream()`
when available and batch `synthesize()` as the fallback.

### `WorkersAITTS` vs `WorkersAIRealtimeTTS`

- `WorkersAITTS` is batch and supports the model's configured encoding, sample
  rate, and container.
- `WorkersAIRealtimeTTS extends WorkersAITTS` adds a stateless
  `synthesizeStream()` implementation. Each sentence lazily opens a Workers AI
  WebSocket, sends `Speak` then `Flush`, yields 20 ms audio frames until
  `Flushed`, and closes when completed, aborted, or abandoned. Its inherited
  `synthesize()` is the batch fallback.
- Browser WebRTC/SFU uses `{ encoding: "linear16", sampleRate: 24000 }`, which
  declares PCM16 at 24 kHz for `SFUVoiceTransport`.
- Phone carriers use the no-options default: 8 kHz μ-law, forwarded
  byte-for-byte when the adapter selects μ-law output.

`VoiceServerAudioTransport` (server-side egress) is distinct from the
client-side `VoiceTransport`; they are not competing abstractions.

## Build & test

- Build: `pnpm exec nx run agents:build` (or root `pnpm run build`).
- Tests: `pnpm vitest run --project voice-workers` from `packages/agents`.
- Provider packages (`voice-providers/*`) and examples resolve the **built
  dist**: rebuild after source changes before typechecking them.

## Conventions

- Keep the upstream file layout. Put fork additions in new files and export
  them from the bottom of `index.ts`'s export block, so upstream merges apply
  cleanly.
- Provider interfaces and Workers AI wrappers belong in `types.ts` /
  `workers-ai.ts`. Carrier adapters (SignalWire, etc.) live in
  `voice-providers/*` and do NOT depend on `env.AI`.
- SFU is composed explicitly:
  `withSFUVoiceTransport(withVoice(Agent, { audioFormat: "pcm16", sampleRate: 24000 }))`.
- `import type` for type-only imports (enforced by `verbatimModuleSyntax`).

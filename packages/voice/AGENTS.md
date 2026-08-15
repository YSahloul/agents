# packages/voice — @cloudflare/voice

Server-side voice pipeline for the Agents SDK: continuous STT, TTS,
interruption/barge-in, configurable conversation history, and the WebSocket
voice protocol. Optional SFU/WebRTC transport.

## Source layout

- `voice.ts` — the `withVoice` mixin: the full pipeline (STT → LLM `onTurn` →
  TTS), interrupt handling, the WS protocol, and the TTS dispatcher. Also
  re-exports the public surface.
- `voice-input.ts` — `withVoiceInput`: STT-only variant (no TTS/LLM) for
  transcription-only agents.
- `sfu-voice.ts` — `withSFUVoice`: composes `withVoice`, pins pcm16, and wires
  `createAudioTransport` to the SFU transport. Not a parallel pipeline.
- `workers-ai-providers.ts` — Workers AI binding wrappers: `WorkersAITTS`,
  `WorkersAIRealtimeTTS`, `WorkersAIFluxSTT`, `WorkersAINova3STT`.
- `types.ts` — provider interfaces and protocol types.
- `sfu-transport.ts`, `sfu-voice-client.ts`, `sfu-utils.ts` — SFU/WebRTC stack.
- `audio-pipeline.ts`, `sentence-chunker.ts`, `text-stream.ts` — internals.

## TTS providers — the three shapes (read before touching TTS)

One job (text → audio), three provider interfaces:

| Interface                  | Method                   | Capability                              | Built-in implementor                       |
| -------------------------- | ------------------------ | --------------------------------------- | ------------------------------------------ |
| `TTSProvider`              | `synthesize(text)`       | Batch whole-sentence blob               | `WorkersAITTS`                             |
| `StreamingTTSProvider`     | `synthesizeStream(text)` | Audio stream for one speech-ready chunk | `WorkersAIRealtimeTTS`, external providers |
| `StreamingTextTTSProvider` | `synthesizeTextStream()` | Model text deltas → audio stream        | `WorkersAIGrokTTS`                         |

### Dispatcher precedence

`voice.ts` sends model text deltas directly when
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

- Build: `pnpm exec nx run voice:build` (or root `pnpm run build`).
- Tests: `pnpm test` in this package (`vitest --project voice-workers`;
  `test:react` needs `pnpm exec playwright install`).
- Typecheck: `npx tsc --noEmit -p tsconfig.json`.
- Provider packages (`voice-providers/*`) and examples resolve the **built
  dist** — rebuild this package after source changes before typechecking them.

## Conventions

- Provider interfaces and the Workers AI wrappers belong in THIS package
  (`types.ts` / `workers-ai-providers.ts`). Carrier-specific transport adapters
  (SignalWire, etc.) live in `voice-providers/*` and do NOT depend on `env.AI`.
- Follow upstream patterns: prefer config-driven options over sibling classes;
  `withVoiceInput` / `withSFUVoice` are the precedent for sibling `with*` entry
  points (both compose `withVoice`, neither reimplements the pipeline).
- `import type` for type-only imports (enforced by `verbatimModuleSyntax`).

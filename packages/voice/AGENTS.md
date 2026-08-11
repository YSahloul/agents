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
  `WorkersAIMulawRealtimeTTS`, `WorkersAIFluxSTT`, `WorkersAINova3STT`.
- `types.ts` — provider interfaces and protocol types.
- `sfu-transport.ts`, `sfu-voice-client.ts`, `sfu-utils.ts` — SFU/WebRTC stack.
- `audio-pipeline.ts`, `sentence-chunker.ts`, `text-stream.ts` — internals.

## TTS providers — the three shapes (read before touching TTS)

ONE job (text → audio), THREE provider interfaces, each a different
**capability**. A class implements whichever its engine can do; the framework
auto-selects the best path.

| Interface              | Method                   | What it is                                                                  | Built-in implementor        |
| ---------------------- | ------------------------ | --------------------------------------------------------------------------- | --------------------------- |
| `TTSProvider`          | `synthesize(text)`       | **batch** — whole-sentence blob                                             | `WorkersAITTS`              |
| `StreamingTTSProvider` | `synthesizeStream(text)` | **per-sentence stream** — stateless async generator (HTTP-style)            | (elevenlabs, telnyx)        |
| `RealtimeTTSProvider`  | `createSession(opts)`    | **live session** — stateful, bidirectional, `speak`/`flush`/`clear`/`close` | `WorkersAIMulawRealtimeTTS` |

### Dispatcher precedence (auto-selected from what the provider implements)

`voice.ts` picks ONE path per provider:

1. **realtime session** — if `createSession` exists (`#startRealtimeTTS`,
   guarded by `typeof tts.createSession === "function"`) → `#realtimeTTSPipeline`.
2. **synthesizeStream** — else if `synthesizeStream` exists →
   `#streamingTTSPipeline` per-sentence branch.
3. **batch** — else `synthesize()` → `#streamingTTSPipeline` batch branch, or
   `#synthesizeWithHooks` for string `onTurn` returns.

The mixin types `tts` as `TTSProvider & Partial<RealtimeTTSProvider> &
Partial<StreamingTTSProvider>`; the dispatcher does runtime
`typeof ... === "function"` checks. Conditionally exposing a method is the
intended extension model — a provider only gets a path if it implements the
method.

### sentence-granular vs token-granular (why two streaming mechanisms exist)

- `synthesizeStream` runs **per sentence**: the pipeline's `SentenceChunker`
  waits for a full sentence, then calls `synthesizeStream(sentence)`. Audio for
  a sentence can't start until that sentence is fully generated.
- The realtime session runs **per token**: `#realtimeTTSPipeline` calls
  `session.speak(token)` on every LLM token. Audio can start from the first
  token, and `clear()` gives mid-utterance barge-in.

That token-granular + interruptible profile is the entire reason
`RealtimeTTS*` exists alongside upstream's `StreamingTTSProvider`.

### `WorkersAITTS` vs `WorkersAIMulawRealtimeTTS`

- `WorkersAITTS` — batch, config-driven (`model`, `encoding` ∈
  linear16/mulaw/mp3/opus/…, `sampleRate`, `container`). General-purpose.
- `WorkersAIMulawRealtimeTTS extends WorkersAITTS` — adds `createSession`,
  **pinned** to μ-law 8 kHz, token-granular, with 20 ms frame pacing for
  telephony. Connect-on-use WebSocket (NOT always-on — allowed to close between
  turns; persistent sockets hit 1011 errors in production). **One consumer: the
  SignalWire phone example.**

`VoiceServerAudioTransport` (server-side egress) is a distinct layer from
upstream's client-side `VoiceTransport` — not competing abstractions.

### Picking a TTS

- **Browser (WebRTC/SFU)**: `WorkersAITTS` with pcm16 (batch today; no pcm16
  realtime/streaming provider exists in-tree).
- **Phone trunk (SignalWire)**: `WorkersAIMulawRealtimeTTS` (μ-law realtime
  session).
- **HTTP streaming TTS (elevenlabs/telnyx)**: their `StreamingTTSProvider`
  implementations.

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

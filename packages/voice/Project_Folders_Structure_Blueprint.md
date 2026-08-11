# @cloudflare/voice — Project Folder Structure Blueprint

**Generated**: 2026-08-10 | **Package version**: 0.3.5 | **Monorepo**: `@cloudflare/agents-repo` (pnpm + Nx)

---

## Auto-Detection Summary

| Dimension              | Detection                                                   | Evidence                                                           |
| ---------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------ |
| **Language / Runtime** | TypeScript (strict), Node.js tooling, Workers target        | `tsconfig.json`, `package.json` type=module, ESM build entrypoints |
| **Framework**          | Cloudflare Agents SDK plugin (`withVoice` mixin)            | Peer dependency on `agents >=0.20.2`                               |
| **Monorepo**           | Yes — pnpm workspaces + Nx                                  | `pnpm-workspace.yaml`, `nx.json`                                   |
| **Microservices**      | No — published SDK package, not a service                   | `publishConfig.access: public`                                     |
| **Frontend**           | Yes — React client hooks + SFU WebRTC transport             | `voice-react.tsx`, `voice-client.ts`, `sfu-transport.ts`           |
| **Primary domain**     | Voice pipeline: STT, TTS, VAD, interruption, streaming, SFU |

---

## 1. Structural Overview

### Monorepo Context

The `@cloudflare/voice` package lives inside the `@cloudflare/agents-repo` monorepo, a pnpm-workspace monorepo orchestrated by Nx for task caching and dependency ordering. The monorepo is organized into several workspace groups:

```
packages/          Published npm packages (agents, voice, codemode, ai-chat, shell, think, …)
voice-providers/   Transport adapter packages (plivo, twilio, signalwire, telnyx, elevenlabs, …)
examples/          Self-contained demo apps (playground, voice-agent, voice-agent-webrtc, …)
docs/              Markdown docs for developers.cloudflare.com
design/            Architecture and design decision records
experimental/      Work-in-progress experiments
guides/            In-depth pattern tutorials
```

### Voice Package Architecture

The voice package follows a **capability-mixin** architectural pattern. The core pipeline (`voice.ts`) is a union of three optional composable layers — STT, TTS, and SFU transport — built as mixins on top of the Agents SDK `Agent` class:

- **`withVoice`** — full voice pipeline (STT → LLM → TTS) with interruption/barge-in and WebSocket voice protocol
- **`withVoiceInput`** — STT-only variant (no TTS/LLM) for transcription-only agents
- **`withSFUVoice`** — composes `withVoice`, pins pcm16 audio, wires SFU transport

Internally, the source is organized **by capability** rather than by layer — each public API surface gets its own entrypoint file, with provider interfaces and helper modules colocated.

### Organizational Principles

1. **Entrypoint = public API boundary**: `src/voice.ts`, `src/voice-client.ts`, `src/voice-react.tsx` are the three published exports
2. **Provider interfaces define extension points**: `types.ts` declares abstract interfaces; `workers-ai-providers.ts` provides the built-in Workers AI implementations
3. **Test mirrors source**: `src/tests/` has a 1:1 test-to-source mapping with an `agents/` subdirectory containing minimal Agent subclasses used as test harnesses
4. **Build emits dist/ + bundled docs/**: `tsdown` bundles three entrypoints; `copyPackageDocs` pulls in `docs/` content

---

## 2. Directory Visualization

```
packages/voice/
├── src/                              # Source code (37 TS/TSX files)
│   ├── voice.ts                      # [53.7KB] Core: withVoice mixin, WS protocol, TTS dispatcher, re-exports
│   ├── voice-input.ts                # [12.9KB] withVoiceInput: STT-only mixin
│   ├── voice-client.ts              # [38.9KB] Client-side voice transport (PartySocket + WebSocket)
│   ├── voice-react.tsx              # [14.2KB] React hooks: useVoiceAgent, useVoiceInput
│   ├── sfu-voice.ts                 # [3.9KB]  withSFUVoice: composes withVoice + SFU transport
│   ├── sfu-transport.ts            # [24.8KB] SFU/WebRTC server-side transport layer
│   ├── sfu-voice-client.ts         # [12.1KB] Client-side SFU WebRTC transport
│   ├── sfu-utils.ts                # [9.2KB]  SFU WebRTC utility functions
│   ├── types.ts                     # [10.9KB] Provider interfaces & voice protocol types
│   ├── workers-ai-providers.ts      # [28.7KB] Built-in Workers AI bindings (TTS + STT)
│   ├── audio-pipeline.ts            # [6.6KB]  Audio processing pipeline (VAD, resampling)
│   ├── text-stream.ts              # [8.5KB]  Text streaming helpers for LLM output
│   ├── sentence-chunker.ts          # [3.4KB]  Sentence boundary detection for TTS chunking
│   ├── tests/                       # Workers-runtime unit + integration tests (21 files)
│   │   ├── voice.test.ts           # [58.1KB] Core voice pipeline tests
│   │   ├── voice-input.test.ts     # [13.3KB] Voice-input mixin tests
│   │   ├── voice-client.test.ts    # [35.3KB] Client transport tests
│   │   ├── voice-eviction.test.ts  # [3.1KB]  Session eviction tests
│   │   ├── sfu-voice.test.ts       # [5.6KB]  SFU voice mixin tests
│   │   ├── sfu-transport.test.ts   # [13.8KB] SFU transport tests
│   │   ├── sfu-voice-client.test.ts # [13.3KB] SFU client transport tests
│   │   ├── sfu-utils.test.ts       # [13.1KB] SFU utility tests
│   │   ├── sfu-integration.test.ts # [3.6KB]  SFU end-to-end integration
│   │   ├── workers-ai-providers.test.ts # [19.1KB] Provider tests
│   │   ├── audio-pipeline.test.ts  # [8.7KB]  Audio pipeline tests
│   │   ├── text-stream.test.ts     # [9.3KB]  Text stream tests
│   │   ├── text-stream-boundaries.test.ts # [4.4KB] Text boundary edge case tests
│   │   ├── sentence-chunker.test.ts # [4.8KB] Sentence chunker tests
│   │   ├── worker.ts              # [1.1KB]  Test DO worker entrypoint
│   │   ├── setup.ts               # [412B]   Global test setup
│   │   ├── env.d.ts               # [252B]   wrangler types
│   │   ├── vitest.config.ts       # [895B]   Workers test project config
│   │   ├── tsconfig.json          # [63B]    Extends root tsconfig
│   │   ├── wrangler.jsonc         # [1.9KB]  wrangler config for Workers tests
│   │   └── agents/                # Minimal Agent subclasses for test harnesses
│   │       ├── voice.ts
│   │       ├── voice-input.ts
│   │       └── sfu-voice.ts
│   └── react-tests/                # Browser-based React hook tests (Playwright)
│       ├── useVoiceAgent.test.tsx  # [27.0KB]
│       ├── useVoiceInput.test.tsx  # [14.7KB]
│       └── vitest.config.ts       # [477B]   React test project config
├── docs/                           # User-facing documentation (copied to dist on build)
│   └── index.md                   # [27.0KB] Package docs
├── scripts/                        # Build scripts
│   └── build.ts                   # [688B]   tsdown build + copy docs + format declarations
├── package.json                    # Package manifest with 3 exports
├── tsconfig.json                   # Extends agents/tsconfig; excludes tests
├── vitest.config.ts               # Root vitest config (delegates to project configs)
├── README.md                       # Package README
├── AGENTS.md                       # Agent instructions for this package
└── CHANGELOG.md                    # Release history
```

### Voice Providers (sibling workspace group)

```
voice-providers/
├── plivo/src/                       audio/, index.ts, setup.ts, types.ts
├── twilio/src/                      (similar extension pattern)
├── signalwire/src/                  (similar extension pattern)
├── telnyx/src/                      (similar extension pattern)
├── elevenlabs/src/                  (similar extension pattern)
├── deepgram/src/                    (similar extension pattern)
└── assemblyai/src/                  (similar extension pattern)
```

Each voice-provider package follows the same structure: `src/index.ts` (main export), `src/types.ts`, optional `src/audio/` or `src/setup.ts`, `tests/` directory, `scripts/build.ts`, `vitest.config.ts`, `package.json`.

---

## 3. Key Directory Analysis

### Source Code (`src/`)

| File                      | Role                                                                  | Size   | Exported Symbols                                                                                 |
| ------------------------- | --------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------ |
| `voice.ts`                | Core pipeline: `withVoice` mixin, WS protocol handler, TTS dispatcher | 53.7KB | `withVoice`, re-exports all public surface                                                       |
| `voice-input.ts`          | STT-only pipeline: `withVoiceInput` for transcription agents          | 12.9KB | `withVoiceInput`                                                                                 |
| `voice-client.ts`         | Browser/client-side transport over PartySocket / WebSocket            | 38.9KB | `VoiceClient`, `VoiceClientTransport`                                                            |
| `voice-react.tsx`         | React hooks for voice integration in browser UIs                      | 14.2KB | `useVoiceAgent`, `useVoiceInput`                                                                 |
| `sfu-voice.ts`            | Composes `withVoice` with SFU transport, pins pcm16                   | 3.9KB  | `withSFUVoice`                                                                                   |
| `sfu-transport.ts`        | Server-side WebRTC/SFU transport layer                                | 24.8KB | `VoiceServerAudioTransport`                                                                      |
| `sfu-voice-client.ts`     | Client-side WebRTC/SFU transport                                      | 12.1KB | `SFUVoiceClient`                                                                                 |
| `sfu-utils.ts`            | WebRTC utilities (SDP, ICE, codec negotiation)                        | 9.2KB  | SFU utility functions                                                                            |
| `types.ts`                | Provider interfaces & protocol message types                          | 10.9KB | `TTSProvider`, `StreamingTTSProvider`, `RealtimeTTSProvider`, `STTProvider`, `VoiceAgentOptions` |
| `workers-ai-providers.ts` | Workers AI binding implementations                                    | 28.7KB | `WorkersAITTS`, `WorkersAIMulawRealtimeTTS`, `WorkersAIFluxSTT`, `WorkersAINova3STT`             |
| `audio-pipeline.ts`       | Audio processing (VAD, resampling)                                    | 6.6KB  | `AudioPipeline`                                                                                  |
| `text-stream.ts`          | Text streaming helpers for LLM output                                 | 8.5KB  | `TextStream`                                                                                     |
| `sentence-chunker.ts`     | Sentence boundary detection                                           | 3.4KB  | `SentenceChunker`                                                                                |

### TTS Provider Architecture

The package defines **three provider interfaces** with automatic dispatch:

| Interface              | Method                   | Capability                    | Built-in                    |
| ---------------------- | ------------------------ | ----------------------------- | --------------------------- |
| `TTSProvider`          | `synthesize(text)`       | Batch (whole-sentence blob)   | `WorkersAITTS`              |
| `StreamingTTSProvider` | `synthesizeStream(text)` | Per-sentence async generator  | ElevenLabs, Telnyx          |
| `RealtimeTTSProvider`  | `createSession(opts)`    | Token-granular, bidirectional | `WorkersAIMulawRealtimeTTS` |

Dispatcher precedence: realtime session → `synthesizeStream` → batch `synthesize()`.

### Tests (`src/tests/`, `src/react-tests/`)

Two separate vitest projects:

- **`src/tests/`** — Workers-runtime tests using `@cloudflare/vitest-pool-workers`. Tests run inside the Workers runtime for accurate DO behavior. The `agents/` subdirectory contains minimal Agent subclass harnesses.
- **`src/react-tests/`** — Browser-based tests using `@vitest/browser` + Playwright. Tests exercise React hooks (`useVoiceAgent`, `useVoiceInput`) in a real browser.

Test pattern: every source file has a corresponding `*.test.ts` file in `src/tests/` with matching name.

---

## 4. File Placement Patterns

### Configuration Files

| Type                   | Location                           | Purpose                                            |
| ---------------------- | ---------------------------------- | -------------------------------------------------- |
| TypeScript config      | `tsconfig.json`                    | Extends `agents/tsconfig` (strict); excludes tests |
| Test TypeScript config | `src/tests/tsconfig.json`          | Extends root tsconfig                              |
| Vitest config          | `vitest.config.ts`                 | Delegates to project-level configs                 |
| Workers test vitest    | `src/tests/vitest.config.ts`       | Configures `@cloudflare/vitest-pool-workers`       |
| React test vitest      | `src/react-tests/vitest.config.ts` | Configures `@vitest/browser` + Playwright          |
| wrangler config        | `src/tests/wrangler.jsonc`         | Workers runtime bindings for tests                 |
| Package manifest       | `package.json`                     | Dependencies, exports, scripts, publish config     |

### Model / Entity Definitions

- **Domain types / provider interfaces**: `src/types.ts` — the single source of truth for all public-facing types
- **Provider implementations**: `src/workers-ai-providers.ts` for built-in; `voice-providers/*/src/` for carrier-specific adapters
- **Protocol message types**: colocated with the pipeline code that produces/consumes them (`voice.ts`, `voice-client.ts`)

### Business Logic

- **Voice pipeline orchestration**: `src/voice.ts` — STT → LLM → TTS, interruption, WS protocol
- **TTS dispatch**: `src/voice.ts` — runtime capability detection and path selection
- **Audio processing**: `src/audio-pipeline.ts` — VAD, resampling, format conversion
- **Text processing**: `src/text-stream.ts`, `src/sentence-chunker.ts`
- **Transport**: `src/sfu-transport.ts` (server), `src/sfu-voice-client.ts` + `src/voice-client.ts` (client)

### Interface Definitions

All provider interfaces are in `src/types.ts`. There is no separate `interfaces/` directory. The convention is: interfaces live in a `types.ts` file at the package root, co-located with the code that consumes them.

### Test Files

- **Unit/integration tests**: `src/tests/<name>.test.ts` — mirrors source file naming 1:1
- **React hook tests**: `src/react-tests/use<HookName>.test.tsx`
- **Test harnesses (minimal DO classes)**: `src/tests/agents/`
- **Test setup**: `src/tests/setup.ts` (global beforeAll/afterAll)
- **Test DO worker**: `src/tests/worker.ts` (Durable Object entrypoint for Workers tests)

### Documentation Files

- **Package docs**: `docs/index.md` — copied to `dist/docs/` on build via `copyPackageDocs`
- **Agent instructions**: `AGENTS.md` — consumed by AI coding agents
- **Public README**: `README.md` — published to npm / GitHub

---

## 5. Naming and Organization Conventions

### File Naming

| Convention        | Pattern                               | Examples                                                                       |
| ----------------- | ------------------------------------- | ------------------------------------------------------------------------------ |
| Source files      | `kebab-case.ts`                       | `voice.ts`, `voice-input.ts`, `sentence-chunker.ts`, `workers-ai-providers.ts` |
| React components  | `kebab-case.tsx`                      | `voice-react.tsx`                                                              |
| Test files        | `<source-name>.test.ts`               | `voice.test.ts`, `audio-pipeline.test.ts`                                      |
| ESM modules       | `*.ts` (verbatimModuleSyntax)         | All source/test files                                                          |
| Type-only imports | `import type { X } from …` (enforced) | Throughout                                                                     |

### Folder Naming

| Convention          | Pattern                               | Examples                          |
| ------------------- | ------------------------------------- | --------------------------------- |
| Package directory   | Exact npm name (no scope)             | `voice/`, `plivo/`, `signalwire/` |
| Source              | `src/`                                | Standard                          |
| Tests               | `src/tests/` (not top-level `tests/`) | Colocated in `src/`               |
| React tests         | `src/react-tests/`                    | Separate vitest project           |
| Test harness agents | `src/tests/agents/`                   | Minimal DO subclasses             |
| Scripts             | `scripts/`                            | Build tooling only                |
| Docs                | `docs/`                               | Copied to dist on build           |

### Export / Module Patterns

- **3 public entrypoints** defined in `package.json` exports: `.`, `./client`, `./react`
- `src/voice.ts` is the main barrel — it re-exports all public symbols from subordinate modules
- Internal modules (`audio-pipeline.ts`, `sentence-chunker.ts`, etc.) are NOT directly importable (no package.json export)
- Cross-package imports resolve through `dist/` for sibling packages (voice-providers depend on built `@cloudflare/voice`)

### Import Organization

- `import type` for type-only imports (enforced by `verbatimModuleSyntax: true`)
- External runtime deps: `agents` (peer), `partysocket` (peer, optional), `react` (peer, optional)
- Internal modules use relative imports: `import { … } from "./types.ts"`

---

## 6. Navigation and Development Workflow

### Entry Points

1. **New contributor start here**: `src/voice.ts` — the `withVoice` mixin is the central pipeline; read from the top for the architecture
2. **Provider interfaces**: `src/types.ts` — understand `TTSProvider`, `StreamingTTSProvider`, `RealtimeTTSProvider`, `STTProvider`
3. **Adding a new carrier**: study `voice-providers/plivo/src/index.ts` — it imports `withVoice` from `@cloudflare/voice`, implements the provider interfaces
4. **Build pipeline**: `scripts/build.ts` — tsdown with 3 entrypoints, declaration generation, doc copying

### Common Development Tasks

| Task                    | Where to Edit                                                                                                                |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Add a new TTS provider  | `src/types.ts` (interface if needed), `src/workers-ai-providers.ts` (if Workers AI) or new `voice-providers/<name>/` package |
| Modify voice pipeline   | `src/voice.ts` — TTS dispatch, WS protocol, interruption logic                                                               |
| Change STT behavior     | `src/voice.ts` (flow) or `src/workers-ai-providers.ts` (STT provider impl)                                                   |
| Update client transport | `src/voice-client.ts` (PartySocket path), `src/sfu-voice-client.ts` (WebRTC path)                                            |
| Update React hooks      | `src/voice-react.tsx`                                                                                                        |
| Add a test              | `src/tests/<name>.test.ts` (Workers) or `src/react-tests/<name>.test.tsx` (browser)                                          |
| Update package docs     | `docs/index.md`                                                                                                              |
| Add a new export        | `package.json` exports + `scripts/build.ts` entry array                                                                      |

### Dependency Flow

```
voice-react.tsx ──→ voice-client.ts ──→ PartySocket
       │                    │
       ▼                    ▼
voice.ts ◄──── types.ts ──── workers-ai-providers.ts
  │                              │
  ├── voice-input.ts             ├── WorkersAITTS
  ├── sfu-voice.ts               ├── WorkersAIMulawRealtimeTTS
  ├── audio-pipeline.ts          ├── WorkersAIFluxSTT
  ├── text-stream.ts             └── WorkersAINova3STT
  └── sentence-chunker.ts

sfu-transport.ts ──→ sfu-utils.ts
sfu-voice-client.ts ──→ sfu-utils.ts
```

### Content Statistics

| Metric                                | Count                    |
| ------------------------------------- | ------------------------ |
| Total source files (TS/TSX)           | 37                       |
| Test files                            | 21                       |
| Total package files (excl. generated) | 48                       |
| Largest source file                   | `voice.ts` (53.7KB)      |
| Largest test file                     | `voice.test.ts` (58.1KB) |
| Public entrypoints                    | 3                        |
| Provider interfaces in `types.ts`     | 5+                       |
| Built-in provider implementations     | 4                        |
| Voice-provider carrier adapters       | 7                        |
| vitest projects                       | 2                        |

---

## 7. Build and Output Organization

### Build Configuration

| File                      | Role                                                           |
| ------------------------- | -------------------------------------------------------------- |
| `scripts/build.ts`        | Orchestrates tsdown build, declaration formatting, doc copying |
| `package.json` scripts    | `build`, `test`, `test:workers`, `test:react`                  |
| `package.json` nx.targets | Nx caching inputs/outputs for build                            |

### Build Process

1. **tsdown** bundles 3 entrypoints (`voice.ts`, `voice-client.ts`, `voice-react.tsx`) into `dist/`
2. `formatDeclarationFiles()` runs oxfmt on generated `.d.ts` files
3. `copyPackageDocs(import.meta.url, "voice")` copies `docs/` to `dist/docs/`
4. Output: `dist/voice.js` + `.d.ts`, `dist/voice-client.js` + `.d.ts`, `dist/voice-react.js` + `.d.ts`

### Build Outputs

```
dist/
├── voice.js / voice.d.ts           # Main: withVoice, withVoiceInput, types, providers
├── voice-client.js / voice-client.d.ts   # ./client export
├── voice-react.js / voice-react.d.ts     # ./react export
├── docs/
│   └── index.md                    # Copied from docs/
└── sourcemaps
```

### Environment-Specific Builds

The package has no environment-specific builds. All builds are production ESM. Tests use `wrangler.jsonc` for Workers runtime configuration, which handles environment binding via `vars` and `bindings` rather than build-time flags.

---

## 8. Technology-Specific Organization

### TypeScript / Workers SDK

- **Strict mode**: inherited from `agents/tsconfig` (strict, ES2021 target, ES2022 modules, bundler resolution)
- **verbatimModuleSyntax**: `true` — all type-only imports must use `import type`
- **ESM only**: `type: "module"`, no CJS fallback (Workers runtime is ESM-only)
- **Workers runtime target**: `skipNodeModulesBundle: true` preserves `cloudflare:workers` external
- **No native deps**: All code runs in Workers v8 isolate; no FFI, no Node.js APIs

### Provider Extension Model

The package uses a **runtime duck-typing dispatch** for TTS providers rather than a class hierarchy:

```typescript
// In voice.ts — runtime capability detection, not instanceof
if (typeof tts.createSession === "function") {
  // realtime path
} else if (typeof tts.synthesizeStream === "function") {
  // streaming path
} else if (typeof tts.synthesize === "function") {
  // batch path
}
```

A provider only needs to implement the methods corresponding to its capabilities; the framework auto-selects the best available path. New voice-provider packages (SignalWire, Plivo, Twilio, etc.) implement one or more of these interfaces and pass their instance to `withVoice(options)`.

### React Hooks

- `useVoiceAgent(options)` — full voice agent with STT + TTS
- `useVoiceInput(options)` — transcription-only agent
- Both return a `VoiceClient` instance and React state for connection lifecycle
- Peer dependency on `react@^19.0.0` (optional — not required for server-only use)

---

## 9. Extension and Evolution

### Extension Points

1. **New TTS/STT providers**: Implement `TTSProvider` / `STTProvider` interfaces from `@cloudflare/voice` types. Create a new `voice-providers/<name>/` package. The `withVoice` mixin accepts any object conforming to the interface.
2. **New transport**: Implement `VoiceTransport` or `VoiceServerAudioTransport`. The SFU path (`sfu-transport.ts`) is the reference.
3. **New pipeline variant**: Follow the `withVoiceInput` / `withSFUVoice` pattern — create a new mixin that composes `withVoice` and overrides specific options.
4. **New React hooks**: Add to `voice-react.tsx`; export via the `./react` entrypoint.

### Adding a New Voice Provider (Template)

```
voice-providers/<name>/
├── src/
│   ├── index.ts          # Main export: implements provider interface(s)
│   ├── types.ts          # Provider-specific types (optional)
│   └── <domain>/         # Domain-specific utilities (audio, setup, etc.)
├── tests/
│   └── index.test.ts
├── scripts/
│   └── build.ts          # Standard tsdown build
├── package.json           # Depends on @cloudflare/voice (peer or direct)
├── tsconfig.json          # Extends agents/tsconfig
├── vitest.config.ts       # Standard vitest config
└── README.md
```

### Scalability Patterns

- **File size boundaries**: When a source module exceeds ~30KB, it signals a candidate for extraction. `voice.ts` (53.7KB) and `voice-client.ts` (38.9KB) are at the high end — future refactors may split protocol handling or TTS dispatch into dedicated modules.
- **Test isolation**: Two separate vitest projects let Workers-runtime tests and browser-based React tests evolve independently. New test categories should follow this pattern (add a new vitest project).
- **Provider separation**: Carrier-specific adapters live outside this package in `voice-providers/` — the voice package stays provider-agnostic.

---

## 10. Structure Enforcement

### Automated Enforcement

| Tool                                  | Scope               | What It Checks                                                  |
| ------------------------------------- | ------------------- | --------------------------------------------------------------- |
| **Oxlint** (`pnpm run lint`)          | All `.ts`/`.tsx`    | `no-explicit-any`, `no-unused-vars`, correctness, accessibility |
| **Oxfmt** (`pnpm run format`)         | All source          | Trailing commas off, 80-char width, consistent style            |
| **TypeScript** (`pnpm run typecheck`) | All source          | Strict mode, no implicit any, verbatim module syntax            |
| **check:exports**                     | `package.json`      | Verifies exports map matches actual dist output                 |
| **Nx affected**                       | Build/test pipeline | Only rebuilds/test packages changed since `main`                |

### Manual Conventions

- **No new top-level directories** without first establishing the pattern in AGENTS.md
- **Tests stay in `src/tests/`** — not a sibling `tests/` directory
- **Provider implementations stay in `voice-providers/`** — not in `packages/voice/src/`
- **Docs updates require `pnpm run build`** before the changes appear in consuming packages

### Documentation Practices

- Architecture decisions: `design/voice.md` (monorepo-level design record)
- Agent instructions: `packages/voice/AGENTS.md` (source layout, TTS architecture, build instructions)
- User-facing docs: `packages/voice/docs/index.md` (published with the package)
- Changelog: `packages/voice/CHANGELOG.md` (release notes, no changesets needed for examples/guides/sites)

---

## Maintaining This Blueprint

This blueprint reflects the package structure as of 2026-08-10 (version 0.3.5). Update it when:

- New public entrypoints are added to `package.json` exports
- New source modules or directory patterns are introduced
- The TTS provider dispatch hierarchy changes
- New vitest projects are added for new test categories
- The build pipeline changes (new bundler, new entrypoints, new output formats)

**Review cadence**: Re-evaluate after every minor version bump or significant refactor.

---

_Generated by the Folder Structure Blueprint Generator — [`folder-structure-blueprint-generator`](skill://folder-structure-blueprint-generator)_

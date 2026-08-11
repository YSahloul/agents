# ICM Agent — Folder Structure as Backend

A minimal proof of concept: an **ICM (Interpreted Context Methodology) workspace
lives inside a Durable Object's virtual filesystem and drives the agent stage by
stage.** The agent has no hardcoded pipeline. At each stage it reads its own
`stages/NN/CONTEXT.md` contract out of its filesystem and follows it. Edit the
markdown, and the agent's behavior changes — no code change.

This ports the ICM idea from "files on a local disk driven from a terminal" to "a
Cloudflare Agent driven from a chat UI", for non-technical users.

## What it shows

- **The ICM workspace IS the backend** — `src/icm-workspace.ts` seeds a 3-stage
  `script-to-animation` workspace (CONTEXT.md routers, brand-vault references,
  stage contracts) into the DO filesystem on first start.
- **The agent reads its own brain** — `onChatMessage` builds the system prompt by
  reading the current stage's `CONTEXT.md` from the `Workspace` (DO SQLite + R2),
  not from hardcoded strings.
- **Stage sequencer in DO state** — `stageIndex` tracks the pipeline. Tools
  `save_artifact` and `advance_stage` move it forward. Checkpoints are chat
  pauses.
- **Per-user isolation** — each browser gets its own DO instance (`name:
getUserId()`), so each user has their own workspace and pipeline progress.
- **Glass box** — the sidebar shows each stage's status, its stage contract (the
  agent's instructions), and the saved output artifact.

## Architecture mapping (ICM → Agents SDK)

| ICM concept                      | This PoC                                              |
| -------------------------------- | ----------------------------------------------------- |
| Workspace folder                 | `Workspace` from `@cloudflare/shell` (DO SQLite + R2) |
| Stage `CONTEXT.md` contract      | Read at runtime to build the system prompt            |
| Layer 3 references (brand-vault) | Seeded files the agent reads via `read_file` tool     |
| Layer 4 `output/` artifacts      | `save_artifact` writes to `stages/NN/output/`         |
| Stage numbering = engine         | `stageIndex` in DO state + `advance_stage` tool       |
| Checkpoints                      | The agent pauses in chat for human approval           |
| Terminal                         | `useAgent` + `useAgentChat` web client                |

## Run

You need Wrangler authenticated against an account with Workers AI access
(`ai.remote: true`).

```sh
npm install
npm start
```

Open the Vite URL. Try: _"Make a 30 second explainer about why caching is hard."_
The agent loads stage 01's contract, proposes angles, pauses for your pick, then
drafts and saves the script before advancing to stage 02.

## Where to take it next

- Swap the final `output/` sink to R2 or a real render service.
- Load the full ICM workspaces as bundled **Agent Skills** (`agents:skills`).
- Add more workspaces and let the user pick one per agent instance.
- Promote the stage sequencer to a Cloudflare Workflow for durable, resumable
  multi-step runs.

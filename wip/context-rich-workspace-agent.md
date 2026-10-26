# Context-Rich Workspace Agent

## Status

Exploratory product and architecture notes. The core direction is promising, but the event model, filesystem conventions, retrieval strategy, and permission boundaries are not yet design decisions.

## Origin

This idea came from a discussion about Stan's AI content product. Stan described an agent that connects to sources such as Google, Slack, Notion, and meeting notes, notices potentially useful events, asks the user for more context, and creates content in the user's voice.

The useful idea is broader than content creation: an agent can observe a person's real activity, maintain an evolving representation of that person's world, retrieve the relevant history when needed, and act proactively.

The Agents SDK repository already contains most of the substrate for a stronger version of that idea:

- Think for persistent sessions, context blocks, tools, compaction, channels, and durable turns.
- Workspace for a durable, inspectable filesystem backed by SQLite with optional R2 spillover.
- Workspace tools that let a Think agent read, write, edit, list, find, grep, and run bounded shell-style operations over its files.
- Agents SDK event surfaces such as email, webhooks, calls, messages, schedules, and programmatic turns.
- Code Mode integration through `state.*` tools for searching and changing multiple files in one execution.

## Product thesis

Give each user a durable Workspace that continuously evolves as events occur in their life and business. Their Think agent operates inside that Workspace, using Context Blocks for compact working context and files for the complete inspectable record.

The agent should not merely wait for questions. It should be able to:

1. Observe new events.
2. Preserve the original evidence.
3. Update its current understanding of people, projects, decisions, and commitments.
4. Notice when something requires attention.
5. Retrieve the relevant supporting history.
6. Recommend or perform an authorized action.
7. Learn from the user's corrections and the action's outcome.

A content agent is one view over this system. The same substrate could support an executive assistant, sales agent, relationship assistant, operations agent, or voice agent.

## Why Workspace matters

Workspace can become the user's evolving external mind rather than a collection of uploaded attachments.

It has several useful properties:

- Durable across agent eviction and future sessions.
- Inspectable by the user instead of hidden inside model memory.
- Editable by the agent through ordinary filesystem operations.
- Able to preserve original sources beside derived understanding.
- Navigable on demand, avoiding insertion of the user's entire history into every model request.
- Shareable through a `WorkspaceLike` proxy when multiple agents need a common user-owned Workspace.
- Suitable for both direct model tools and Code Mode's `state.*` API.

Workspace should remain a pure durable filesystem. Event routing, interpretation, agent execution, and permission policy belong in the application around it.

## Relationship to Think Context Blocks

Workspace and Context Blocks solve different problems and should remain separate.

### Context Blocks

Context Blocks hold bounded information that the model should receive on every relevant turn:

- `SOUL`: identity, values, behavior, and durable instructions.
- `USER`: stable facts and communication preferences.
- `CURRENT_STATE`: active goals, projects, relationships, and commitments.
- `MEMORY`: a compact set of important learned facts.

Think freezes the assembled Context Blocks into the system prompt. This is useful for prefix caching and stable behavior, but it means volatile data does not update automatically after a Workspace write. A Workspace-backed Context Block must be refreshed deliberately with `session.refreshSystemPrompt()`, or excluded from the cached prompt.

### Workspace

Workspace holds the larger world that should be retrieved only when relevant:

- Original emails and attachments.
- Call recordings, metadata, and transcripts.
- Message history.
- Calendar events.
- Documents and business records.
- Complete relationship timelines.
- Project artifacts and historical decisions.
- Agent-generated drafts and completed work.

The concise rule is:

> Context Blocks orient the agent; Workspace contains the world; tools retrieve the relevant evidence.

A Context Block may serve as a table of contents for the Workspace. For example, `CURRENT_STATE` can identify active projects and commitments and include paths to their detailed files.

## Proposed information layers

### Source events

Original or minimally transformed evidence. These records should not be casually rewritten by the model.

```text
/sources/
  /email/2026/08/message-id.eml
  /calls/2026/08/call-id/
    metadata.json
    transcript.txt
  /calendar/event-id.json
  /messages/thread-id.jsonl
```

### Current world model

Derived, correctable understanding of the user's present world.

```text
/people/
  /jane-smith/
    profile.md
    relationship.md
    interactions.jsonl

/projects/
  /new-location/
    brief.md
    status.md
    decisions.jsonl

/commitments/
  active.jsonl
  completed.jsonl

/preferences/
  communication.md
  decisions.md
```

### Navigation indexes

Small files that let the agent discover relevant material without scanning the entire Workspace.

```text
/index/
  people.json
  projects.json
  commitments.json
  recent-events.jsonl
```

Each consequential derived fact should retain a source path when possible. If an agent incorrectly concludes that Jane accepted a proposal, the user or agent should be able to trace that conclusion back to the email or call that produced it.

## Event flow

A new email is a representative example:

```text
Email arrives
  -> authenticate and resolve the owning user
  -> resolve the user's durable agent or Workspace
  -> write the original email under /sources/email/
  -> update navigation indexes
  -> determine whether interpretation is needed
  -> update relevant person, project, and commitment files
  -> determine whether the event warrants a Think turn
  -> refresh volatile Context Blocks when necessary
  -> recommend or perform an authorized action
  -> write the action and outcome back to Workspace
```

The ingestion path should do deterministic work deterministically. It should preserve the source, assign stable paths, deduplicate events, and update mechanical indexes without asking a model. The model is needed for meaning: identifying decisions, obligations, relationships, uncertainty, and appropriate next actions.

Calls may be an especially valuable source because they contain intent, objections, urgency, commitments, and relationship changes that are absent from formal business records.

## Proactivity

Proactivity should begin with explicit triggers rather than periodic, unconstrained model exploration.

Examples:

- A call ends.
- A new email or message arrives.
- A commitment becomes due.
- A calendar event approaches.
- A customer replies after a proposal.
- The same objection appears repeatedly.
- A record changes materially.
- No response has arrived after a configured period.

For each trigger, the system should decide:

1. Did anything materially change?
2. Is an action warranted?
3. What evidence supports that conclusion?
4. Is the agent authorized to act?
5. Does the action require approval?

Possible permission levels:

- **Observe:** update internal records without notifying the user.
- **Recommend:** present evidence and a proposed action.
- **Execute:** perform a pre-authorized, reversible action.

Payments, legal commitments, destructive changes, and sensitive external communications should remain approval-gated.

## Existing codebase support

The current implementation supports this direction:

- `packages/think/src/think.ts` creates a SQLite-backed Workspace for every Think instance and adds Workspace tools to every inference turn.
- `packages/think/src/tools/workspace.ts` implements the model-facing filesystem tools.
- `packages/shell/src/filesystem.ts` implements durable files backed by SQLite with optional R2 spillover.
- `packages/shell/src/workspace.ts` adapts Workspace to the shared filesystem backend.
- `packages/shell/src/workers.ts` exposes Workspace through Code Mode's `state.*` tool provider.
- `packages/agents/src/experimental/memory/session/context.ts` supports readonly, writable, searchable, and on-demand Context Block providers.
- `packages/agents/src/index.ts` exposes the `onEmail` event hook needed for email ingestion.

Think does not automatically convert incoming events into files or update a user world model. That application-level convention is the missing product layer.

## Current retrieval limit

Think's built-in Workspace `grep` scans matching files sequentially, skips files larger than 1 MB, and stops after 200 matches. That is appropriate for a modest Workspace but not sufficient by itself for years of email, calls, and documents.

The first solution should be disciplined paths and small navigation indexes. Semantic indexing should be added only after concrete retrieval failures demonstrate that manifests, paths, and text search are insufficient.

Context providers offer another bridge. A searchable Context Block provider could search Workspace-derived indexes, while a provider used for `CURRENT_STATE` could render a compact projection of selected Workspace files.

## Identity and ownership

By default, Think's Workspace belongs to one Think Durable Object instance. The application must therefore choose the ownership boundary deliberately:

- One Think instance and Workspace per user.
- One Workspace per business with multiple channel-specific Think instances using a shared `WorkspaceLike` proxy.
- A parent-owned Workspace shared with specialized child agents.

The correct boundary depends on whether context belongs to the person, the business, a conversation, or a temporary task. Conversation history should remain in Session; durable user or business knowledge should not be trapped in one channel-specific session.

## Strongest initial product

The smallest coherent version is a voice-first business agent that remembers every relevant relationship, commitment, and decision.

After each call, it records:

- What happened?
- What changed?
- Who is involved?
- What was decided?
- What was promised?
- What remains uncertain?
- What should happen next?
- When should it happen?
- May the agent perform it automatically?

Before the next interaction, it retrieves:

- Who is this person?
- What is the relationship?
- What happened previously?
- What do they currently want?
- What has been promised?
- What outcome does the user want now?
- What must not be said or done?

This uses the repository's existing strengths without requiring every possible integration at the beginning.

## Open questions

- Is the primary Workspace owned by a user, business, household, or agent?
- Which events should cause a model turn versus deterministic ingestion only?
- Which derived files may the agent rewrite without approval?
- How are source citations represented consistently inside derived files?
- How are conflicting facts represented instead of silently overwritten?
- Which current-state information belongs in always-on Context Blocks?
- When should a Workspace update invalidate the frozen system prompt?
- How should multiple specialized agents coordinate over one shared Workspace?
- What is the minimum retrieval index needed before semantic search becomes necessary?
- How does the user inspect, correct, export, and delete their accumulated world model?
- Which proactive actions are safe by default, and which always require approval?

## Working conclusion

The repository already contains the core runtime pieces for a context-rich proactive agent. The primary design work is the convention connecting events, Workspace files, Context Blocks, retrieval, triggers, and permissions.

The intended architecture is not to put the user's whole life into the system prompt. It is to maintain a durable, inspectable world in Workspace, keep a compact orientation layer in Think Context Blocks, and let the agent retrieve evidence and act when a concrete event makes that context relevant.

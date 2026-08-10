import { createWorkersAI } from "workers-ai-provider";
import { routeAgentRequest, callable } from "agents";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
  streamText,
  convertToModelMessages,
  pruneMessages,
  tool,
  stepCountIs
} from "ai";
import { z } from "zod";
import { Workspace, type FileInfo } from "@cloudflare/shell";
import { WORKSPACE_FILES, WORKSPACE_ROOT } from "./workspace-seed";

type Env = {
  AI: Ai;
  ICMAgent: DurableObjectNamespace<ICMAgent>;
};

type ICMState = { seeded: boolean };

/**
 * Workspace Agent.
 *
 * The ENTIRE workspace lives in this agent's Durable Object filesystem, copied
 * verbatim. The agent operates on it exactly like Claude Code does on the CLI:
 * it reads the workspace's own entry point (CLAUDE.md) and does whatever those
 * files tell it to do.
 *
 * There is NO methodology hardcoded here. The workspace markdown files ARE the
 * framework — the routing, triggers, stage contracts, checkpoints, and audits
 * all live in the files. Swap the seeded workspace for a different one and the
 * agent behaves completely differently, with no code changes.
 *
 * The code provides exactly three things:
 *   1. a durable workspace filesystem,
 *   2. file tools (read / list / write / edit),
 *   3. one instruction: read the entry point and follow it.
 */
export class ICMAgent extends AIChatAgent<Env, ICMState> {
  workspace = new Workspace({
    sql: this.ctx.storage.sql,
    namespace: "icm",
    name: () => this.name
  });

  maxPersistedMessages = 200;
  initialState: ICMState = { seeded: false };

  /** Write the whole workspace into the filesystem once. */
  async ensureSeeded() {
    if (this.state?.seeded) return;
    for (const file of WORKSPACE_FILES) {
      if (!(await this.workspace.exists(file.path))) {
        await this.workspace.writeFile(file.path, file.content);
      }
    }
    this.setState({ seeded: true });
  }

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    await this.ensureSeeded();
    const workersai = createWorkersAI({ binding: this.env.AI });

    // The agent's behavior is NOT hardcoded. The workspace files ARE the
    // framework. We load the workspace's own entry point and tell the model to
    // do exactly what the CLI would: read it, then follow it.
    const claudeMd = await this.workspace.readFile(
      `${WORKSPACE_ROOT}/CLAUDE.md`
    );

    const system = [
      "You are an interactive agent that operates on a project living in a",
      "workspace filesystem. You help the user by reading files, following the",
      "project's own instructions, and writing or editing files to do the work.",
      `The entire workspace is rooted at ${WORKSPACE_ROOT}.`,
      "",
      "# Project instructions are the source of truth",
      "",
      "The workspace contains a CLAUDE.md (shown below) that defines how this",
      "project works — its routing, triggers, conventions, and the files to load",
      "for each task. Treat CLAUDE.md as your top-level instructions. When it",
      "points you to another file (a CONTEXT.md, a reference, a questionnaire),",
      "read that file with read_file before you act on it. Follow nested",
      "instructions the same way: a file you load may itself tell you which other",
      "files to read. Load only what the current task needs — do not read the",
      "whole workspace.",
      "",
      "# Tools",
      "",
      "- read_file: read a workspace file before acting on it.",
      "- list_files: discover what exists; use it instead of guessing paths.",
      "- write_file: create or overwrite a file (e.g. saving a task's output).",
      "- edit_file: change content in place (e.g. filling in placeholders).",
      "",
      "# Behavior",
      "",
      "- Do exactly what the project instructions describe. Do not invent steps,",
      "  stages, or behavior the files do not call for.",
      "- Resolve relative paths against the file you are currently working from.",
      "- When instructions include a checkpoint or a question for the user, stop",
      "  and let the user respond before continuing.",
      "- If CLAUDE.md is missing or empty, list the workspace and read what is",
      "  there to orient yourself.",
      "",
      "# CLAUDE.md (project instructions)",
      "",
      claudeMd ?? "(no CLAUDE.md found — list the workspace and read what is there)"
    ].join("\n");

    const result = streamText({
      abortSignal: options?.abortSignal,
      model: workersai("@cf/moonshotai/kimi-k2.6", {
        sessionAffinity: this.sessionAffinity
      }),
      system,
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages",
        reasoning: "before-last-message"
      }),
      tools: {
        read_file: tool({
          description:
            "Read a workspace file. Accepts an absolute path (starting with " +
            "/workspace) or a path relative to a base you provide.",
          inputSchema: z.object({
            path: z.string().describe("e.g. /workspace/CONTEXT.md"),
            base: z
              .string()
              .optional()
              .describe(
                "Optional base dir to resolve ../ relative paths against, e.g. /workspace/stages/01-script"
              )
          }),
          execute: async ({ path, base }) => {
            const resolved = resolvePath(base ?? WORKSPACE_ROOT, path);
            const content = await this.workspace.readFile(resolved);
            if (content === null) return { error: `Not found: ${resolved}` };
            return { path: resolved, content };
          }
        }),

        list_files: tool({
          description:
            "List workspace files, optionally under a subdirectory glob.",
          inputSchema: z.object({
            pattern: z
              .string()
              .optional()
              .describe("Glob, default /workspace/**/*")
          }),
          execute: async ({ pattern }) => {
            const files = await this.workspace.glob(
              pattern ?? `${WORKSPACE_ROOT}/**/*`
            );
            return { files: files.map((f) => f.path) };
          }
        }),

        write_file: tool({
          description:
            "Write (create or overwrite) a workspace file. Use for saving stage " +
            "outputs and for fully rewriting a file.",
          inputSchema: z.object({
            path: z.string(),
            content: z.string()
          }),
          execute: async ({ path, content }) => {
            const resolved = resolvePath(WORKSPACE_ROOT, path);
            await this.workspace.writeFile(resolved, content);
            return { saved: resolved, bytes: content.length };
          }
        }),

        edit_file: tool({
          description:
            "Replace an exact substring in a workspace file. Use this to fill in " +
            "{{PLACEHOLDERS}} during setup. oldText must appear exactly once.",
          inputSchema: z.object({
            path: z.string(),
            oldText: z.string(),
            newText: z.string()
          }),
          execute: async ({ path, oldText, newText }) => {
            const resolved = resolvePath(WORKSPACE_ROOT, path);
            const content = await this.workspace.readFile(resolved);
            if (content === null) return { error: `Not found: ${resolved}` };
            const count = content.split(oldText).length - 1;
            if (count === 0) return { error: `oldText not found in ${resolved}` };
            const updated = content.split(oldText).join(newText);
            await this.workspace.writeFile(resolved, updated);
            return { edited: resolved, replacements: count };
          }
        })
      },
      stopWhen: stepCountIs(12)
    });

    return result.toUIMessageStreamResponse();
  }

  /** Lets the UI show the live workspace tree (optional, not user-facing). */
  @callable()
  async listWorkspace(): Promise<FileInfo[]> {
    await this.ensureSeeded();
    return this.workspace.readDir(WORKSPACE_ROOT);
  }

  @callable()
  async readWorkspaceFile(path: string): Promise<string | null> {
    await this.ensureSeeded();
    return this.workspace.readFile(resolvePath(WORKSPACE_ROOT, path));
  }
}

/** Resolve ../ and absolute /workspace paths. */
function resolvePath(base: string, path: string): string {
  if (path.startsWith("/")) return path;
  const parts = base.split("/").filter(Boolean);
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return "/" + parts.join("/");
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;

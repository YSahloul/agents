/**
 * Seed the ENTIRE copied ICM workspace into the agent's Durable Object
 * filesystem, verbatim. Every file under ./workspace is bundled at build time
 * as a raw string by Vite, then written to /workspace/* on first start.
 *
 * The agent reads and writes these exact files at runtime — same as the CLI.
 */

// Vite bundles every workspace file as a raw string at build time.
const raw = import.meta.glob("./workspace/**/*", {
  query: "?raw",
  import: "default",
  eager: true
}) as Record<string, string>;

export type SeedFile = { path: string; content: string };

/**
 * Map the bundled module keys (e.g. "./workspace/brand-vault/identity.md") to
 * absolute workspace paths (e.g. "/workspace/brand-vault/identity.md").
 */
export const WORKSPACE_FILES: SeedFile[] = Object.entries(raw).map(
  ([key, content]) => ({
    path: key.replace(/^\.\//, "/"),
    content
  })
);

export const WORKSPACE_ROOT = "/workspace";

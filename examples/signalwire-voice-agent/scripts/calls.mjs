#!/usr/bin/env node
// Turns a `wrangler tail --format json` capture into a per-call, per-turn
// timeline. The raw capture is ~95% media-frame noise; this prints only what
// explains a call: what the caller said, when the model answered, how long
// TTS took, when audio actually reached the carrier, and every error.
//
//   node scripts/calls.mjs [capture.json] [--last] [--all]
//
// --last  only the most recent call (default when a capture holds many)
// --all   every call in the capture

import { existsSync, readFileSync, statSync } from "node:fs";

const args = process.argv.slice(2);
const showAll = args.includes("--all");

// Default to whichever known capture file was written most recently, so this
// works whether the capture came from scripts/tail.sh or an older tail.
const CANDIDATES = ["/tmp/signalwire-calls.json", "/tmp/signalwire-raw.txt"];
const file =
  args.find((a) => !a.startsWith("--")) ??
  CANDIDATES.filter(existsSync).sort(
    (a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs
  )[0];

if (!file) {
  console.error(
    `no capture found. Run ./scripts/tail.sh first (writes ${CANDIDATES[0]}).`
  );
  process.exit(1);
}

/** Stream-parse a file that is a bare sequence of JSON objects. */
function parseEvents(text) {
  const events = [];
  let i = 0;
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (i >= text.length) break;
    const start = i;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (; i < text.length; i++) {
      const c = text[i];
      if (esc) { esc = false; continue; }
      if (c === "\\") { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) { i++; break; }
      }
    }
    try {
      events.push(JSON.parse(text.slice(start, i)));
    } catch {
      /* skip malformed trailing chunk (tail still writing) */
    }
  }
  return events;
}

/** wrangler json logs put console.log args in `message` as an array. */
function logParts(entry) {
  const m = entry?.message;
  if (Array.isArray(m)) return m;
  if (m !== undefined) return [m];
  return [];
}

function collect(events) {
  const rows = [];
  for (const e of events) {
    const ts = e.eventTimestamp ?? 0;
    const version = e.scriptVersion?.id?.slice(0, 8) ?? "";
    const url = e.event?.request?.url ?? "";
    if (url.includes("/answer")) rows.push({ ts, kind: "call_start", version });
    for (const x of e.exceptions ?? []) {
      rows.push({ ts, kind: "exception", text: x.message });
    }
    for (const entry of e.logs ?? []) {
      const parts = logParts(entry);
      const at = entry.timestamp ?? ts;
      const head = typeof parts[0] === "string" ? parts[0] : "";
      if (head === "[VoiceTrace]" && typeof parts[1] === "object") {
        rows.push({ ts: at, kind: "trace", trace: parts[1] });
      } else if (head.startsWith("[SignalWireAdapter]")) {
        if (head.includes("duck")) continue; // per-frame noise
        rows.push({ ts: at, kind: "adapter", text: [head, ...parts.slice(1)]
          .map((p) => (typeof p === "object" ? JSON.stringify(p) : String(p)))
          .join(" ") });
      } else if (entry.level === "error" || head.includes("error") || head.includes("Error")) {
        rows.push({ ts: at, kind: "error", text: parts
          .map((p) => (typeof p === "object" ? JSON.stringify(p) : String(p)))
          .join(" ") });
      }
    }
  }
  return rows.sort((a, b) => a.ts - b.ts);
}

/** Group rows into calls, keyed by connectionId with call_start as a fence. */
function groupCalls(rows) {
  const calls = [];
  let current = null;
  for (const r of rows) {
    const conn = r.trace?.connectionId;
    if (r.kind === "call_start") {
      current = { start: r.ts, version: r.version, conn: null, rows: [] };
      calls.push(current);
      continue;
    }
    if (conn && current && current.conn && current.conn !== conn) {
      current = { start: r.ts, version: current.version, conn, rows: [] };
      calls.push(current);
    }
    if (!current) {
      current = { start: r.ts, version: "", conn: conn ?? null, rows: [] };
      calls.push(current);
    }
    if (conn && !current.conn) current.conn = conn;
    current.rows.push(r);
  }
  return calls.filter((c) => c.rows.length);
}

const secs = (ms) => `${(ms / 1000).toFixed(2)}s`;

function printCall(call, index) {
  const t0 = call.start;
  const clock = new Date(t0).toISOString().slice(11, 19);
  console.log(
    `\n━━━ CALL ${index} — ${clock}Z  conn=${call.conn ?? "?"}  version=${call.version || "?"}`
  );

  let turnStart = null;
  for (const r of call.rows) {
    const rel = `+${((r.ts - t0) / 1000).toFixed(2)}s`.padStart(8);

    if (r.kind === "trace") {
      const t = r.trace;
      switch (t.event) {
        case "stt_utterance":
          console.log(`${rel}  USER  "${t.text}"`);
          break;
        case "onTurn_call":
          turnStart = r.ts;
          console.log(`${rel}  turn start (history: ${t.history?.length ?? 0} msgs)`);
          break;
        case "model_first_delta":
          console.log(`${rel}    model first token   ${t.elapsedMs ?? "?"}ms into turn`);
          break;
        case "tts_sentence":
          console.log(`${rel}    tts synth ${String(t.synthMs).padStart(5)}ms  "${t.text}"`);
          break;
        case "tts_speak_sent":
          console.log(`${rel}    tts speak "${t.text}"`);
          break;
        case "tts_first_audio":
          console.log(`${rel}    ▶ FIRST AUDIO OUT (${t.bytes ?? "?"} bytes)`);
          break;
        case "model_stream_complete":
          console.log(
            `${rel}    model done  ${t.generatedChars} chars${t.aborted ? " (ABORTED)" : ""}  "${(t.text ?? "").slice(0, 60)}"`
          );
          break;
        case "model_stream_error":
          console.log(`${rel}    ✘ MODEL ERROR: ${t.error}`);
          break;
        case "turn_complete": {
          const wall = turnStart ? ` wall ${secs(r.ts - turnStart)}` : "";
          console.log(
            `${rel}  ✓ REPLY DONE  llm ${t.llmMs}ms · tts ${t.ttsMs}ms · first-audio ${t.firstAudioMs}ms · total ${t.totalMs}ms${wall}`
          );
          console.log(`${" ".repeat(10)}"${t.text}"`);
          break;
        }
        case "turn_empty":
          console.log(
            `${rel}  ✘ EMPTY REPLY — ${t.reason} (llm ${t.llmMs}ms, total ${t.totalMs}ms)`
          );
          break;
        case "barge_in":
          console.log(`${rel}  ⟲ barge-in (previous turn aborted)`);
          break;
        case "interrupt":
          console.log(`${rel}  ⟲ interrupt`);
          break;
        default:
          console.log(`${rel}  ${t.event}`);
      }
      continue;
    }

    if (r.kind === "adapter") {
      if (r.text.includes("BARGE-IN")) console.log(`${rel}  ⟲ carrier barge-in`);
      else if (r.text.includes("GATE RELEASED")) continue; // status echo, low value
      else console.log(`${rel}  ${r.text}`);
      continue;
    }

    if (r.kind === "error" || r.kind === "exception") {
      console.log(`${rel}  ✘ ${r.text}`);
    }
  }
}

const text = readFileSync(file, "utf8");
const calls = groupCalls(collect(parseEvents(text)));
if (!calls.length) {
  console.log(`no calls found in ${file}`);
  process.exit(0);
}
const shown = showAll ? calls : calls.slice(-1);
console.log(
  `${file}: ${calls.length} call(s)${showAll ? "" : " — showing last (--all for every call)"}`
);
shown.forEach((c) => printCall(c, calls.indexOf(c) + 1));
console.log("");

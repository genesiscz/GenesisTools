#!/usr/bin/env bun
/**
 * Wait for a Codex worker's current turn to end (run it with Bash run_in_background: the harness wakes the lead when
 * it exits), save the `tools codex wait --json` result, and log the worker's final message to the run ledger.
 *
 *   bun wait-turn.ts --run <dir> --worker <name> --thread <id> [--pr N] [--round N] [--model m]
 *   bun wait-turn.ts --run <dir> --worker <name> --from-file <wait.json> …   (log a result saved earlier)
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toolsEntrypoint } from "@genesiscz/utils/cli/tools";
import { SafeJSON } from "@genesiscz/utils/json";
import { appendEvent } from "./ledger";
import { flag, loadRun } from "./run";

const run = loadRun();
const worker = flag("--worker") ?? "";
const pr = flag("--pr");
const round = flag("--round");
const fromFile = flag("--from-file");
let raw = "";
let exitCode = 0;
let stderr = "";

if (fromFile) {
    raw = readFileSync(fromFile, "utf8");
} else {
    // A steer reaches the daemon a moment after its command returns; waiting at once can catch the previous turn.
    await Bun.sleep(3000);
    const p = Bun.spawnSync(
        [toolsEntrypoint(), "codex", "wait", flag("--thread") ?? "", "--stall-timeout", "1800", "--json"],
        {
            cwd: run.main,
            stdout: "pipe",
            stderr: "pipe",
            env: process.env,
        }
    );
    raw = p.stdout.toString();
    exitCode = p.exitCode ?? 1;
    stderr = p.stderr.toString();
}

const logs = join(run.dir, "logs");
mkdirSync(logs, { recursive: true });
const file = fromFile ?? join(logs, `wait-${worker}-${pr}r${round}-${Date.now()}.json`);

if (!fromFile) {
    writeFileSync(file, raw);
}

let text = "";
let failure: string | null = null;
let meta: Record<string, unknown> = { exit: exitCode, file };

try {
    const result = SafeJSON.parse(raw, { strict: true }) as {
        lastText?: string;
        outcome?: string;
        state?: string;
        error?: string | null;
    };
    text = result.lastText ?? "";
    // `tools codex wait` exits 4 and names the error when the turn died on the API side (2026-10-14: bs-storage's
    // failed remote compaction ended every steer at once, and this line printed "done" with no text).
    failure = result.error ?? null;
    meta = { ...meta, outcome: result.outcome, state: result.state, ...(failure ? { error: failure } : {}) };
} catch {
    text = `(no JSON from tools codex wait) ${stderr.slice(0, 500)}`;
}

appendEvent(run.dir, {
    kind: "turn",
    worker,
    model: flag("--model"),
    ...(pr ? { pr: Number(pr) } : {}),
    ...(round ? { round: Number(round) } : {}),
    text,
    meta,
});
const result = text.match(/RESULT:\s*(.+)/)?.[1] ?? "";

if (failure) {
    console.log(`✖ ${worker} #${pr} r${round} turn FAILED (exit ${exitCode}): ${failure} → ${file}`);
    console.log("  the worker did no work: steer it again later, or move the brief to another worker");
} else {
    console.log(`${worker} #${pr} r${round} turn ended exit=${exitCode} ${result.slice(0, 120)} → ${file}`);
}

// A saved result (--from-file) has no process exit of its own: a failed turn still exits 4, like `tools codex wait`.
process.exitCode = failure && exitCode === 0 ? 4 : exitCode;

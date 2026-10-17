#!/usr/bin/env bun
/**
 * Steer a Codex worker and log the full prompt to the run ledger in one step. A later round is always a steer into
 * the same thread (the worker keeps its context and cache), never a new spawn.
 *
 *   bun steer.ts --run <dir> --worker <name> --file <prompt.md> [--model m] [--pr N] [--round N]
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readTurnBaseline } from "@app/ai/commands/agent/wait";
import { execTool } from "@genesiscz/utils/cli";
import { appendEvent } from "./ledger";
import { flag, loadRun } from "./run";

const run = loadRun();
const worker = flag("--worker") ?? "";
const prompt = flag("--file") ?? "";

if (!worker || !prompt) {
    console.error("usage: steer.ts --run <dir> --worker <name> --file <prompt.md> [--model m] [--pr N] [--round N]");
    process.exit(2);
}

const file = resolve(prompt);
const pr = flag("--pr") ? { pr: Number(flag("--pr")) } : {};
const round = flag("--round") ? { round: Number(flag("--round")) } : {};
const baseline = await readTurnBaseline("codex", worker, false);
const sentAt = Date.now();
// Logged BEFORE the delivery: the worker's turn starts while `codex steer` still runs, and watch-workers names a
// worker's PR from its latest steer, so a steer logged afterwards labelled the new turn with the old PR (2026-10-14).
appendEvent(run.dir, {
    kind: "steer",
    worker,
    model: flag("--model"),
    ...pr,
    ...round,
    text: readFileSync(file, "utf8"),
    meta: {
        sentAt,
        sessionId: baseline?.sessionId,
        baselineTurnStartedAt: baseline?.turnStartedAt ?? undefined,
        baselineTranscriptBytes: baseline?.transcriptBytes,
    },
});
const p = await execTool(["codex", "steer", "--name", worker, "--prompt-file", file], {
    cwd: run.main,
    timeout: 30_000,
});
const ok = p.success && !p.timedOut;

if (!ok) {
    appendEvent(run.dir, {
        kind: "note",
        worker,
        ...pr,
        ...round,
        text: `steer NOT delivered: ${p.stderr.toString().slice(0, 300)}`,
    });
}
console.log(`steer ${worker} exit=${p.exitCode}`);
process.exit(ok ? 0 : p.exitCode || 1);

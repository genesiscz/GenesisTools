#!/usr/bin/env bun
/**
 * Steer a Codex worker and log the full prompt to the run ledger in one step. A later round is always a steer into
 * the same thread (the worker keeps its context and cache), never a new spawn.
 *
 *   bun steer.ts --run <dir> --worker <name> --file <prompt.md> [--model m] [--pr N] [--round N]
 */
import { readFileSync } from "node:fs";
import { appendEvent } from "./ledger";
import { flag, loadRun } from "./run";

const run = loadRun();
const worker = flag("--worker") ?? "";
const file = flag("--file") ?? "";

if (!worker || !file) {
    console.error("usage: steer.ts --run <dir> --worker <name> --file <prompt.md> [--model m] [--pr N] [--round N]");
    process.exit(2);
}

const p = Bun.spawnSync(["./tools", "codex", "steer", "--name", worker, "--prompt-file", file], {
    cwd: run.main,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
});
const ok = p.exitCode === 0;
appendEvent(run.dir, {
    kind: "steer",
    worker,
    model: flag("--model"),
    ...(flag("--pr") ? { pr: Number(flag("--pr")) } : {}),
    ...(flag("--round") ? { round: Number(flag("--round")) } : {}),
    text: readFileSync(file, "utf8"),
    meta: ok ? { delivered: true } : { delivered: false, error: p.stderr.toString().slice(0, 300) },
});
console.log(`steer ${worker} exit=${p.exitCode}`);
process.exit(ok ? 0 : 1);

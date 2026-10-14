#!/usr/bin/env bun
/**
 * A Monitor source for every reviewer: every `--every` seconds it runs round-ready.ts and prints a PR's line only
 * when its head, any reviewer's review of that head, its open threads or the PR comments by others changed, so each
 * event is one PR worth looking at. No reviewer is filtered out: on 2026-10-14 this dropped CodeRabbit from the key,
 * and only eve's state could wake the lead.
 * Ends after `--for` minutes (a Claude Code Monitor dies at 30 minutes anyway; re-arm it with the same command).
 *
 *   bun watch-reviews.ts --run <dir> [--every 120] [--for 30] <N> [<N> ...]
 *
 * Start it as `bun <path>` in the Monitor command, not through a wrapper script's shebang: a zsh wrapper started
 * that way delivered no event for 25 minutes on 2026-10-14, the same loop under `zsh <path>` delivered at once.
 */
import { join } from "node:path";
import { flag, loadRun } from "./run";

const run = loadRun();
const every = Number(flag("--every") ?? 120) * 1000;
const deadline = Date.now() + Number(flag("--for") ?? 30) * 60_000;
const prs = process.argv.slice(2).filter((a, i, all) => /^\d+$/.test(a) && !all[i - 1]?.startsWith("--"));
const seen = new Map<string, string>();

if (prs.length === 0) {
    console.error("usage: watch-reviews.ts --run <dir> [--every 120] [--for 30] <N> [<N> ...]");
    process.exit(2);
}

while (Date.now() < deadline) {
    const p = Bun.spawnSync(["bun", join(import.meta.dir, "round-ready.ts"), "--run", run.dir, ...prs], {
        cwd: run.main,
        stdout: "pipe",
        stderr: "pipe",
        env: process.env,
    });

    for (const line of p.stdout.toString().split("\n").filter(Boolean)) {
        const pr = line.split(" ")[0];

        if (seen.get(pr) !== line) {
            seen.set(pr, line);
            console.log(line);
        }
    }

    if (p.exitCode !== 0) {
        console.log(`round-ready failed (exit ${p.exitCode}): ${p.stderr.toString().trim().slice(0, 200)}`);
    }

    await Bun.sleep(Math.min(every, Math.max(0, deadline - Date.now())));
}

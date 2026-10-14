/**
 * The run card every babysit script reads: `<run dir>/run.json`, written by the lead at the start of a run.
 * The run dir comes from `--run <dir>` or `BABYSIT_RUN`. Only `vault` and `judge` have no sensible default.
 *
 *   { "vault": "<notes folder of this run>", "judge": "Claude Opus 5.5", "repo": "owner/name",
 *     "worktrees": "<dir>", "reviewLoopScripts": "<dir>", "prs": [...], ... }
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";

export interface RunCard {
    /** The run folder: run.json, ledger.jsonl, briefs, logs. */
    dir: string;
    /** owner/name of the GitHub repository. */
    repo: string;
    /** The main checkout (the parent of the git common dir). */
    main: string;
    /** Where reply files, summaries and the rendered ledger go. */
    vault: string;
    /** The name the round summary credits as judge. */
    judge: string;
    /** Parent folder of the per-PR worker worktrees (`bs-<N>`). */
    worktrees: string;
    reviewLoopScripts: string;
}

export function flag(name: string): string | undefined {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : undefined;
}

export function has(name: string): boolean {
    return process.argv.includes(name);
}

function capture(cmd: string[], cwd?: string): string {
    const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe", env: process.env });
    return p.exitCode === 0 ? p.stdout.toString().trim() : "";
}

export function loadRun(dir = flag("--run") ?? process.env.BABYSIT_RUN): RunCard {
    if (!dir) {
        console.error("no run dir: pass --run <dir> or set BABYSIT_RUN");
        process.exit(2);
    }

    const runDir = resolve(dir);
    const cardPath = join(runDir, "run.json");
    const card: Record<string, unknown> = existsSync(cardPath)
        ? (SafeJSON.parse(readFileSync(cardPath, "utf8")) as Record<string, unknown>)
        : {};
    const text = (key: string): string | undefined =>
        typeof card[key] === "string" ? (card[key] as string) : undefined;
    const commonDir = capture(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"]);

    return {
        dir: runDir,
        repo: text("repo") ?? capture(["gh", "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]),
        main: text("main") ?? (commonDir ? dirname(commonDir) : process.cwd()),
        vault: text("vault") ?? join(runDir, "vault"),
        judge: text("judge") ?? "Claude",
        worktrees: text("worktrees") ?? join(runDir, "worktrees"),
        reviewLoopScripts: text("reviewLoopScripts") ?? join(homedir(), ".claude/skills/review-loop/scripts"),
    };
}

export function worktreeFor(run: RunCard, pr: string | number): string {
    return join(run.worktrees, `bs-${pr}`);
}

/**
 * The run card every babysit script reads: `<run dir>/run.json`, written by the lead at the start of a run.
 * The run dir comes from `--run <dir>` or `BABYSIT_RUN`. Only `vault` and `judge` have no sensible default.
 *
 *   { "vault": "<notes folder of this run>", "judge": "Claude Opus 5.5", "repo": "owner/name",
 *     "worktrees": "<dir>", "reviewLoopScripts": "<dir>", "prs": [...], ... }
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { env } from "@genesiscz/utils/env";
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
    /** Publication requires true or an explicit --post; absent permission means ask. */
    post?: boolean | "ask";
    /**
     * The brief's verify bullets for a repository whose checks are not GenesisTools' (run.json `verify`, one string
     * per bullet). Unset: fill-brief writes GenesisTools' test, tsgo, Biome and lint-rules commands.
     */
    verify?: string[];
}

export function flag(name: string): string | undefined {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : undefined;
}

export function has(name: string): boolean {
    return process.argv.includes(name);
}

function capture(cmd: string[], cwd?: string): string {
    const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe", env: env.getProcessEnv() });
    return p.exitCode === 0 ? p.stdout.toString().trim() : "";
}

/**
 * `--run` names the run folder; the path of its run.json is accepted too. A folder that does not exist, or a path to
 * any other file, is an error: the fallbacks in `loadRun` would quietly answer for the current checkout's repository
 * (2026-10-14: `--run <dir>/run.json` made round-ready report GenesisTools #94, a closed PR, for GenesisPlayground #94).
 */
export function runPaths(given: string): { runDir: string; cardPath: string } {
    const path = resolve(given);
    if (basename(path) === "run.json") {
        if (!existsSync(path)) {
            throw new Error(`no run card at ${path}`);
        }

        return { runDir: dirname(path), cardPath: path };
    }

    if (!existsSync(path) || !statSync(path).isDirectory()) {
        throw new Error(`run dir ${path} is not a folder: pass the folder that holds run.json`);
    }

    return { runDir: path, cardPath: join(path, "run.json") };
}

export function loadRun(dir = flag("--run") ?? env.get("BABYSIT_RUN")): RunCard {
    if (!dir) {
        console.error("no run dir: pass --run <dir> or set BABYSIT_RUN");
        process.exit(2);
    }

    let paths: { runDir: string; cardPath: string };
    try {
        paths = runPaths(dir);
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(2);
    }

    const { runDir, cardPath } = paths;
    if (!existsSync(cardPath)) {
        console.error(`no run.json in ${runDir}: the repo, checkout and vault come from the current checkout`);
    }

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
        post: typeof card.post === "boolean" ? card.post : "ask",
        worktrees: text("worktrees") ?? join(runDir, "worktrees"),
        reviewLoopScripts: text("reviewLoopScripts") ?? join(homedir(), ".claude/skills/review-loop/scripts"),
        verify:
            Array.isArray(card.verify) && card.verify.every((line) => typeof line === "string")
                ? (card.verify as string[])
                : undefined,
    };
}

export function worktreeFor(run: RunCard, pr: string | number): string {
    return join(run.worktrees, `bs-${pr}`);
}

/** A reviewer's probe folder, beside the run folder: its brief names it and the approval driver accepts writes there. */
export function reviewScratch(runDir: string, pr: string | number): string {
    return join(runDir, "..", `review-${pr}`);
}

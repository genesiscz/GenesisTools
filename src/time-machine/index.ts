#!/usr/bin/env bun

/**
 * tools time-machine — auto-bisect a failing command across git history.
 *
 * Runs `<cmd...>` against the current working tree. If it passes, there is
 * nothing to bisect. If it fails, we walk back through git history checking
 * out each candidate commit IN A THROWAWAY WORKTREE (never the user tree) and
 * re-running the command, binary-searching for the FIRST commit that fails —
 * the one that introduced the failure. We then report that commit's metadata
 * and its diff.
 *
 * SAFETY: every probe runs in a detached worktree under the OS temp dir. The
 * user's working tree, branch, and index are never modified. The temp worktree
 * is always cleaned up (even on error / interrupt).
 *
 * Usage:
 *   tools time-machine -- <cmd...>
 *   tools time-machine --depth 50 -- npm test
 *   tools time-machine --good v1.2.0 -- ./run-checks.sh
 */

import { logger, out } from "@app/logger";
import { runTool } from "@app/utils/cli";
import { Command } from "commander";
import { findFirstBad } from "./lib/bisect";
import {
    type CommitInfo,
    checkoutInWorktree,
    createTempWorktree,
    getCommitDiff,
    getCommitInfo,
    isGitRepo,
    listCommits,
    resolveRef,
    runCommandInDir,
} from "./lib/git";

const DEFAULT_DEPTH = 30;

interface TimeMachineOptions {
    depth: number;
    good?: string | null;
    cwd: string;
}

export interface TimeMachineReport {
    /** Outcome of the run. */
    status: "no-commits" | "already-green" | "found" | "predates-range" | "not-in-history";
    /** The first failing commit, when status === "found". */
    firstBad?: CommitInfo;
    /** The last green commit (parent of firstBad), when known. */
    lastGood?: CommitInfo | null;
    /** Full `git show` diff of firstBad, when status === "found". */
    diff?: string;
    /** Number of commits considered in the search window. */
    candidates: number;
    /** Number of command runs spent probing history (excludes the HEAD probe). */
    probes: number;
}

/**
 * Drive the bisect end-to-end against a real git repo. Returns a structured
 * report; the caller decides how to render it. This is the orchestration seam
 * the integration test exercises — keep it free of process.exit / printing.
 */
export async function runTimeMachine(command: string[], options: TimeMachineOptions): Promise<TimeMachineReport> {
    const { depth, good, cwd } = options;

    // 1. Probe the CURRENT working tree. If the command already passes there is
    //    nothing to blame — short-circuit before touching history.
    out.log.step(`Running command in current tree: ${command.join(" ")}`);
    const headRun = await runCommandInDir({ command, cwd, captureOutput: true });
    logger.debug({ exitCode: headRun.exitCode }, "time-machine: head probe");

    if (headRun.exitCode === 0) {
        return { status: "already-green", candidates: 0, probes: 0 };
    }

    out.log.warn(`Command fails at HEAD (exit ${headRun.exitCode}). Walking back through history…`);

    // 2. Resolve the optional --good lower bound.
    let goodSha: string | null = null;
    if (good) {
        goodSha = await resolveRef(good, cwd);
        if (!goodSha) {
            throw new Error(`--good ref "${good}" could not be resolved to a commit.`);
        }

        out.log.info(`Seeded known-good lower bound: ${good} (${goodSha.slice(0, 7)})`);
    }

    // 3. List candidate commits. listCommits returns NEWEST → OLDEST; the
    //    bisect core needs OLDEST → NEWEST (index 0 = oldest = lower bound),
    //    so we reverse. Without this the search blames HEAD every time.
    const newestFirst = await listCommits({ cwd, startRef: "HEAD", depth, goodRef: goodSha });
    const commits = [...newestFirst].reverse(); // oldest → newest

    if (commits.length === 0) {
        return { status: "no-commits", candidates: 0, probes: 0 };
    }

    out.log.info(`Searching ${commits.length} commit(s) for the one that introduced the failure…`);

    // 4. One reusable throwaway worktree for all probes (pay `worktree add`
    //    once). ALWAYS cleaned up, even if a probe throws.
    const headSha = newestFirst[0]?.sha ?? commits[commits.length - 1].sha;
    const worktree = await createTempWorktree({ repoCwd: cwd, sha: headSha });

    try {
        const result = await findFirstBad(commits, async (index) => {
            const commit = commits[index];
            await checkoutInWorktree(commit.sha, worktree.path);
            const run = await runCommandInDir({ command, cwd: worktree.path, captureOutput: true });
            const verdict = run.exitCode === 0 ? "pass" : "fail";
            out.log.step(`  ${commit.shortSha} ${commit.subject} → ${verdict} (exit ${run.exitCode})`);
            return verdict;
        });

        const probes = result.probes;

        if (result.firstBad === null) {
            // Every commit in the window passed even though HEAD failed in step
            // 1 — the failure comes from UNCOMMITTED working-tree changes or the
            // environment, not from any committed snapshot. Nothing to blame.
            return { status: "not-in-history", candidates: commits.length, probes };
        }

        if (result.lastGood === null) {
            const diff = await getCommitDiff(result.firstBad.sha, cwd);

            // When --good seeded a trusted lower bound, the oldest searched
            // commit failing is the EXPECTED success path: the seeded good ref
            // is the last green parent (it lives just below the window, excluded
            // by the good..HEAD range). Report a confirmed "found".
            if (goodSha) {
                const goodInfo = await getCommitInfo(goodSha, cwd);
                return {
                    status: "found",
                    firstBad: result.firstBad,
                    lastGood: goodInfo,
                    diff,
                    candidates: commits.length,
                    probes,
                };
            }

            // No --good: even the OLDEST commit in the window fails, so the
            // failure predates the searched range. Widen --depth or seed --good.
            return {
                status: "predates-range",
                firstBad: result.firstBad,
                lastGood: null,
                diff,
                candidates: commits.length,
                probes,
            };
        }

        const diff = await getCommitDiff(result.firstBad.sha, cwd);
        return {
            status: "found",
            firstBad: result.firstBad,
            lastGood: result.lastGood,
            diff,
            candidates: commits.length,
            probes,
        };
    } finally {
        try {
            await worktree.cleanup();
        } catch (err) {
            logger.warn({ err }, "time-machine: failed to clean up temporary worktree");
        }
    }
}

function renderCommit(commit: CommitInfo): string {
    return [
        `  commit  ${commit.sha}`,
        `  author  ${commit.author} <${commit.authorEmail}>`,
        `  date    ${commit.date}`,
        `  subject ${commit.subject}`,
    ].join("\n");
}

async function main(): Promise<void> {
    const program = new Command()
        .name("time-machine")
        .description("Auto-bisect a failing command across git history (rewind to the last green commit).")
        .option("--depth <n>", "How many commits back to search", String(DEFAULT_DEPTH))
        .option("--good <ref>", "Known-good lower bound (branch/tag/sha); limits the search to good..HEAD")
        .argument("[command...]", "The command to run (everything after `--`)");

    const { command } = await runTool(program, { tool: "time-machine" });

    const commandArgs = command.args;
    if (commandArgs.length === 0) {
        out.log.error("No command given. Usage: tools time-machine -- <cmd...>");
        out.log.info("Example: tools time-machine --depth 50 -- npm test");
        process.exit(1);
    }

    const opts = program.opts();
    const depth = Number.parseInt(opts.depth, 10);
    if (!Number.isInteger(depth) || depth < 1) {
        out.log.error(`--depth must be a positive integer (got "${opts.depth}").`);
        process.exit(1);
    }

    const cwd = process.cwd();
    if (!(await isGitRepo(cwd))) {
        out.log.error(`Not inside a git work tree: ${cwd}`);
        process.exit(1);
    }

    let report: TimeMachineReport;
    try {
        report = await runTimeMachine(commandArgs, { depth, good: opts.good ?? null, cwd });
    } catch (err) {
        out.log.error(`time-machine failed: ${err instanceof Error ? err.message : String(err)}`);
        logger.error({ err }, "time-machine: run failed");
        process.exit(1);
    }

    switch (report.status) {
        case "already-green": {
            out.log.success("Command already passes at HEAD — nothing to bisect.");
            process.exit(0);
            break;
        }
        case "no-commits": {
            out.log.warn("No commits found in the search window. Try a larger --depth or remove --good.");
            process.exit(1);
            break;
        }
        case "not-in-history": {
            out.log.warn(
                `Command fails at HEAD but PASSES at all ${report.candidates} searched commit(s) — the failure is from uncommitted working-tree changes or the environment, not a committed change.`
            );
            out.log.info("Check `git status` / `git diff` for uncommitted changes, or environment differences.");
            process.exit(1);
            break;
        }
        case "predates-range": {
            out.log.warn(
                `The failure was not isolated within the last ${report.candidates} commit(s) — every searched commit failed.`
            );
            out.log.info("Widen the window with --depth, or seed a known-good ref with --good.");
            if (report.firstBad && report.diff) {
                out.print(`\nOldest searched (still failing) commit:\n${renderCommit(report.firstBad)}\n\n`);
                out.result(report.diff);
            }

            process.exit(1);
            break;
        }
        case "found": {
            if (!report.firstBad || !report.diff) {
                out.log.error("Internal error: 'found' report missing commit/diff.");
                process.exit(1);
                break;
            }

            out.log.success(`Found the commit that introduced the failure (after ${report.probes} probe(s)):`);
            if (report.lastGood) {
                out.printErr(`\nLast green commit:\n${renderCommit(report.lastGood)}\n`);
            }

            out.printErr(`\nFirst BAD commit (introduced the failure):\n${renderCommit(report.firstBad)}\n`);
            out.printErr("\n--- diff (git show) ---\n");
            await out.flush();
            out.result(report.diff);
            process.exit(0);
            break;
        }
    }
}

// Only run the CLI when executed directly (`bun src/time-machine/index.ts`),
// not when imported (e.g. by the test, which calls runTimeMachine directly).
if (import.meta.main) {
    main().catch((err) => {
        logger.error({ err }, "time-machine: unexpected error");
        process.exit(1);
    });
}

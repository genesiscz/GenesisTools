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

import { runTool } from "@genesiscz/utils/cli";
import { logger, out } from "@genesiscz/utils/logger";
import { Command } from "commander";
import { type CommitInfo, isGitRepo } from "./lib/git";
import { runTimeMachine, type TimeMachineReport } from "./lib/run";

const DEFAULT_DEPTH = 30;

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

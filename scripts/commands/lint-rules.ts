/**
 * `bun run lint:rules`: the repo lint rules for a local run. The rules live in `scripts/ci/lint-rules.ts`; this file
 * only picks which files they read.
 *
 * By default it checks the files changed since the merge base with `origin/master`, edits on disk included, with the
 * flags of the pre-push hook (`--no-rosters`). Measured 2026-11-18: one full scan of the 10,936 tracked files took
 * 72.6 s and 252.7 CPU-seconds with a 2.79 GB peak, and agents ran it about 66 times a day before a report or a push.
 * `--all`, and any run with `CI` set, keeps the full audit with the roster rules, and still refuses a ratchet list or
 * roster allowance that grew against the base.
 */

import { join } from "node:path";
import { runTool } from "@genesiscz/utils/cli";
import { env } from "@genesiscz/utils/env";
import { logger, out } from "@genesiscz/utils/logger";
import { Command } from "commander";

const CHECKER = join(import.meta.dir, "..", "ci", "lint-rules.ts");
const DEFAULT_BASE = "origin/master";
/** The checker waits up to 15 minutes for the heavy-check slot that other worktrees share, then scans. */
const RUN_DEADLINE_MS = 30 * 60_000;

export interface LintRulesPlan {
    /** The arguments for `scripts/ci/lint-rules.ts`. */
    args: string[];
    /** One line for the person who ran it: what is checked and how to get the rest. */
    note: string;
}

export function lintRulesPlan({
    base = DEFAULT_BASE,
    all = false,
    ci,
}: {
    base?: string;
    all?: boolean;
    ci: boolean;
}): LintRulesPlan {
    if (all || ci) {
        return {
            args: ["--ratchet-base", base],
            note: `lint:rules: every tracked file${ci && !all ? " (CI is set)" : ""}`,
        };
    }

    return {
        args: ["--no-rosters", "--changed", base, "--working-tree"],
        note: `lint:rules: files changed since the merge base with ${base}, edits on disk included (--all checks every file)`,
    };
}

function runChecker(plan: LintRulesPlan): number {
    out.println(plan.note);
    const run = Bun.spawnSync([process.execPath, CHECKER, ...plan.args], {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
        timeout: RUN_DEADLINE_MS,
        killSignal: "SIGKILL",
    });

    if (run.exitedDueToTimeout) {
        logger.error(
            { deadlineMs: RUN_DEADLINE_MS, args: plan.args },
            `lint:rules: the check did not finish within ${RUN_DEADLINE_MS / 60_000} minutes and was killed`
        );
        return 1;
    }

    return run.exitCode ?? 1;
}

if (import.meta.main) {
    const program = new Command("lint:rules")
        .description("The repo lint rules on the files changed since a base, or on every tracked file")
        .option("--base <ref>", "compare with <ref> (the merge base with it)", DEFAULT_BASE)
        .option("--all", "every tracked file, roster rules included (the full audit; also the mode when CI is set)")
        .action((options: { base: string; all?: boolean }) => {
            process.exitCode = runChecker(
                lintRulesPlan({ base: options.base, all: options.all === true, ci: Boolean(env.get("CI")) })
            );
        });

    await runTool(program, { tool: "lint-rules" });
}

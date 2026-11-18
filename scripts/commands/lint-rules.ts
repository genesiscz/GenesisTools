/**
 * `bun run lint:rules`: the repo lint rules for a local run. The rules live in `scripts/ci/lint-rules.ts`; this file
 * only picks which files they read.
 *
 * By default it checks the files changed since the merge base with `origin/master`, edits on disk included, with the
 * flags of the pre-push hook (`--no-rosters`). Measured 2026-11-18: one full scan of the 10,936 tracked files took
 * 72.6 s and 252.7 CPU-seconds with a 2.79 GB peak, and agents ran it about 66 times a day before a report or a push.
 * `--all`, and any run with `CI` set, keeps the full audit with the roster rules.
 */

import { join } from "node:path";

const CHECKER = join(import.meta.dir, "..", "ci", "lint-rules.ts");
const DEFAULT_BASE = "origin/master";
/** The checker waits up to 15 minutes for the heavy-check slot that other worktrees share, then scans. */
const RUN_DEADLINE_MS = 30 * 60_000;

const USAGE = `usage: bun run lint:rules [--base <ref>] [--all]

  (default)     the files changed since the merge base with ${DEFAULT_BASE}, edits on disk included
  --base <ref>  compare with <ref> instead of ${DEFAULT_BASE}
  --all         every tracked file, roster rules included (the full audit; also the mode when CI is set)`;

export interface LintRulesPlan {
    /** The arguments for `scripts/ci/lint-rules.ts`. */
    args: string[];
    /** One line for the person who ran it: what is checked and how to get the rest. */
    note: string;
}

export function lintRulesPlan({ argv, ci }: { argv: string[]; ci: boolean }): LintRulesPlan {
    let base = DEFAULT_BASE;
    let all = false;

    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];

        if (arg === "--all") {
            all = true;
        } else if (arg === "--base") {
            const ref = argv[index + 1];

            if (!ref || ref.startsWith("-")) {
                throw new Error(`lint:rules: --base needs a ref\n${USAGE}`);
            }

            base = ref;
            index++;
        } else {
            throw new Error(`lint:rules: unknown argument ${arg}\n${USAGE}`);
        }
    }

    if (all || ci) {
        return { args: [], note: `lint:rules: every tracked file${ci && !all ? " (CI is set)" : ""}` };
    }

    return {
        args: ["--no-rosters", "--changed", base, "--working-tree"],
        note: `lint:rules: files changed since the merge base with ${base}, edits on disk included (--all checks every file)`,
    };
}

function main(): number {
    const argv = process.argv.slice(2);

    if (argv.includes("--help") || argv.includes("-h")) {
        console.log(USAGE);
        return 0;
    }

    let plan: LintRulesPlan;

    try {
        plan = lintRulesPlan({ argv, ci: Boolean(process.env.CI) });
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        return 2;
    }

    console.log(plan.note);
    const run = Bun.spawnSync([process.execPath, CHECKER, ...plan.args], {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
        timeout: RUN_DEADLINE_MS,
        killSignal: "SIGKILL",
    });

    if (run.exitedDueToTimeout) {
        console.error(`lint:rules: the check did not finish within ${RUN_DEADLINE_MS / 60_000} minutes and was killed`);
        return 1;
    }

    return run.exitCode ?? 1;
}

if (import.meta.main) {
    process.exitCode = main();
}

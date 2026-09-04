/**
 * `tools git base [<branch>]` — which branch is this one based on, and why.
 *
 * Runs the one base-detection ladder (--base, PR target, config
 * mainPrBranch, closest declared branch, closest merge-base) so the skill
 * references tell the model to run a command instead of copying a bash
 * snippet into three places.
 */

import {
    BaseNotFoundError,
    describeBase,
    detectBase,
    getCurrentBranch,
    loadRepoConfig,
    originDriver,
} from "@genesiscz/utils/git";
import { logger, out } from "@genesiscz/utils/logger";
import type { Storage } from "@genesiscz/utils/storage";
import type { Command } from "commander";

const log = logger.scoped("git-base").log;

interface Options {
    base?: string;
    json?: boolean;
    offline?: boolean;
    cwd?: string;
}

async function runBase(branchArg: string | undefined, opts: Options): Promise<number> {
    const cwd = opts.cwd ?? process.cwd();
    const branch = branchArg ?? (await getCurrentBranch(cwd)) ?? undefined;
    const loaded = await loadRepoConfig(cwd);

    for (const problem of loaded.problems) {
        out.log.warn(`config ${loaded.path}: ${problem}`);
    }

    const driver = opts.offline ? null : await originDriver(cwd);
    const base = await detectBase({ cwd, branch, flag: opts.base, config: loaded.config, driver });

    if (opts.json) {
        out.result({ branch: branch ?? null, ...base });
    } else {
        out.println(`${branch ?? "(detached)"} → ${describeBase(base)}`);
    }

    return 0;
}

export function registerBaseCommand(parent: Command, _storage: Storage): void {
    parent
        .command("base [branch]")
        .description("Detect the base branch of a branch (default: the current one) and say which rule decided")
        .option("-b, --base <ref>", "Verify and return this ref instead of detecting")
        .option("--offline", "Skip the PR/MR lookup")
        .option("--json", "Emit as JSON")
        .option("-C, --cwd <path>", "Repository path")
        .action(async (branch: string | undefined, options: Options) => {
            try {
                process.exitCode = await runBase(branch, options);
            } catch (err) {
                if (err instanceof BaseNotFoundError) {
                    out.log.error(err.message);
                    process.exitCode = 2;
                    return;
                }

                log.error({ error: err }, "git base failed");
                out.log.error(err instanceof Error ? err.message : String(err));
                process.exitCode = 1;
            }
        });
}

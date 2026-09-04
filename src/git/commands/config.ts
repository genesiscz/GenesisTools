/**
 * `tools git config show|init|check` — the per-repo `genesis-tools.config.json`.
 *
 * `show` prints the effective file, where it came from, and every branch
 * entry with what it matched. `init` infers a main branch, prints the
 * proposed JSON and writes it to the git common dir after confirmation.
 * `check` validates and exits 1 with the offending entry.
 */

import * as p from "@clack/prompts";
import { isInteractive, suggestCommand } from "@genesiscz/utils/cli";
import {
    branchPolicy,
    createGit,
    formatRepoConfig,
    inferMainBranch,
    loadRepoConfig,
    type RepoConfig,
    writeLocalRepoConfig,
} from "@genesiscz/utils/git";
import { logger, out } from "@genesiscz/utils/logger";
import type { Storage } from "@genesiscz/utils/storage";
import type { Command } from "commander";
import pc from "picocolors";

const log = logger.scoped("git-config").log;

interface CommonOptions {
    cwd?: string;
    json?: boolean;
    yes?: boolean;
}

async function showConfig(opts: CommonOptions): Promise<number> {
    const cwd = opts.cwd ?? process.cwd();
    const loaded = await loadRepoConfig(cwd);
    const inferred = loaded.config.git?.mainPrBranch ? null : await inferMainBranch(cwd);
    const branches = await createGit({ cwd }).listLocalBranchNames();
    const matches = branches.map((b) => ({ branch: b, ...branchPolicy(loaded.config, b) }));

    if (opts.json) {
        out.result({ ...loaded, inferredMainPrBranch: inferred, branches: matches });
        return loaded.problems.length > 0 ? 1 : 0;
    }

    if (loaded.source === "none") {
        out.println(`no config (looked at ${loaded.paths.claude} and ${loaded.paths.gitDir})`);
        out.println(
            inferred
                ? `inferred mainPrBranch = ${inferred.branch} (${inferred.source})`
                : "could not infer a main branch; pass --base to the commands that need one"
        );
        out.println(`create one: ${suggestCommand("tools git config", { replaceCommand: ["init"] })}`);
        return 0;
    }

    out.println(`${loaded.path} (${loaded.source})\n`);
    out.println(formatRepoConfig(loaded.config).trimEnd());

    for (const problem of loaded.problems) {
        out.println(pc.red(`problem: ${problem}`));
    }

    if (loaded.config.git?.branches?.length) {
        out.println("\nlocal branches and the entry they match:");

        for (const m of matches) {
            const extra = m.environment ? ` env=${m.environment}` : "";
            out.println(`  ${m.branch.padEnd(40)} push=${m.push.padEnd(8)} matchedBy=${m.matchedBy}${extra}`);
        }
    }

    return loaded.problems.length > 0 ? 1 : 0;
}

async function initConfig(opts: CommonOptions): Promise<number> {
    const cwd = opts.cwd ?? process.cwd();
    const loaded = await loadRepoConfig(cwd);

    if (loaded.source !== "none" && !opts.yes) {
        out.log.warn(`a config already exists at ${loaded.path}; edit it, or pass --yes to overwrite the local copy`);
        return 1;
    }

    const inferred = await inferMainBranch(cwd);

    if (!inferred) {
        out.log.error("could not infer a main branch (no origin HEAD, no local master/main)");
        return 1;
    }

    const proposed: RepoConfig = {
        git: {
            mainPrBranch: inferred.branch,
            branches: [
                { name: inferred.branch, push: "confirm" },
                { catchAll: true, push: "allowed" },
            ],
        },
    };

    out.println(`inferred mainPrBranch = ${inferred.branch} (${inferred.source})`);
    out.println("if this repository's PRs target another branch, edit mainPrBranch after writing.\n");
    out.println(formatRepoConfig(proposed).trimEnd());
    out.println(`\nwould write ${loaded.paths.gitDir}`);

    if (!opts.yes) {
        if (!isInteractive()) {
            out.log.error("Non-interactive: pass --yes to write the file as printed.");
            out.log.info(suggestCommand("tools git config", { replaceCommand: ["init"], add: ["--yes"] }));
            return 2;
        }

        const ok = await p.confirm({ message: "Write it?", initialValue: true });

        if (p.isCancel(ok) || !ok) {
            out.log.info("Nothing written.");
            return 1;
        }
    }

    const path = await writeLocalRepoConfig(cwd, proposed);
    out.log.success(`wrote ${path}`);
    return 0;
}

async function checkConfig(opts: CommonOptions): Promise<number> {
    const cwd = opts.cwd ?? process.cwd();
    const loaded = await loadRepoConfig(cwd);

    if (loaded.source === "none") {
        out.println("no config file; nothing to check");
        return 0;
    }

    if (loaded.problems.length === 0) {
        out.log.success(`${loaded.path}: ok`);
        return 0;
    }

    for (const problem of loaded.problems) {
        out.log.error(`${loaded.path}: ${problem}`);
    }

    return 1;
}

export function registerConfigCommand(parent: Command, _storage: Storage): void {
    const config = parent
        .command("config")
        .description("Per-repository genesis-tools.config.json: main PR branch and push policy per branch");

    const wrap = (fn: (opts: CommonOptions) => Promise<number>) => async (opts: CommonOptions) => {
        try {
            process.exitCode = await fn(opts);
        } catch (err) {
            log.error({ error: err }, "git config failed");
            out.log.error(err instanceof Error ? err.message : String(err));
            process.exitCode = 1;
        }
    };

    config
        .command("show")
        .description("Effective config, its source path, and what each local branch matches")
        .option("--json", "Emit as JSON")
        .option("-C, --cwd <path>", "Repository path")
        .action(wrap(showConfig));

    config
        .command("init")
        .description("Infer the main branch, print the proposed file, write it to the git common dir")
        .option("--yes", "Write without asking (also overwrites an existing local copy)")
        .option("-C, --cwd <path>", "Repository path")
        .action(wrap(initConfig));

    config
        .command("check")
        .description("Validate the config file; exit 1 with the offending entry")
        .option("-C, --cwd <path>", "Repository path")
        .action(wrap(checkConfig));
}

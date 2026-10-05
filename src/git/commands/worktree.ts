/**
 * `tools git worktree config|init|sync-plans` — worktree creation policy for this repo.
 *
 * `config` is the guided setup and the only place the policy is written. `init` creates or
 * finds a worktree and runs the configured install. `sync-plans` rescues `.claude/plans`
 * into the main checkout and is what the post-commit hook calls.
 *
 * `init` refuses to run unconfigured rather than defaulting, because a wrong base directory
 * scatters worktrees across the disk and moving one afterwards means rewriting its gitdir
 * pointer. The refusal names the command that fixes it.
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import * as p from "@clack/prompts";
import { isInteractive, suggestCommand } from "@genesiscz/utils/cli";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import {
    createGit,
    formatRepoConfig,
    loadRepoConfig,
    type RepoConfig,
    type WorktreeSection,
    writeLocalRepoConfig,
} from "@genesiscz/utils/git";
import { logger, out } from "@genesiscz/utils/logger";
import type { Storage } from "@genesiscz/utils/storage";
import type { Command } from "commander";
import pc from "picocolors";
import { syncPlansToMain } from "../lib/worktree/plans";
import {
    basePresetExamples,
    WorktreeNotConfiguredError,
    worktreeDirName,
    worktreePolicy,
} from "../lib/worktree/policy";

const log = logger.scoped("git-worktree").log;

type WorktreeField = "base" | "install" | "plansSync";

const WORKTREE_DEFAULTS: WorktreeSection = { base: ".claude/worktrees", install: "bun install", plansSync: true };

interface WorktreeOptions {
    cwd?: string;
    json?: boolean;
    hook?: boolean;
    branch?: string;
    create?: boolean;
    base?: string;
}

/**
 * The MAIN checkout's root, not the caller's. `layout()` reports the current worktree's
 * toplevel and the shared common dir, and every worktree of a repo answers with the same
 * common dir, which is exactly the identity the config and the plan rescue need.
 */
async function repoRootOf(cwd: string): Promise<string> {
    const { commonDir } = await createGit({ cwd }).layout();
    return commonDir.replace(/\/\.git$/, "");
}

function refuse(repoRoot: string): number {
    out.log.error("`git.worktrees` is not configured for this repository.");
    out.log.info(`Repository: ${repoRoot}`);
    out.log.info(suggestCommand("tools git worktree", { replaceCommand: ["config"] }));
    return 1;
}

export async function runConfig(options: WorktreeOptions): Promise<number> {
    const cwd = options.cwd ?? process.cwd();
    const repoRoot = await repoRootOf(cwd);
    const loaded = await loadRepoConfig(cwd);
    const presets = basePresetExamples(repoRoot);

    if (options.json) {
        out.result({ repoRoot, current: loaded.config.git?.worktrees ?? null, presets, source: loaded.source });
        return 0;
    }

    if (!isInteractive()) {
        out.log.error(`\`${toolCommand("git worktree config")}\` needs a TTY to run the guided setup.`);
        out.log.info(
            "Write the section by hand instead: .claude/genesis-tools.config.json (versioned) or <git-common-dir>/genesis-tools.config.json (local, which is what the wizard writes):"
        );
        out.print(
            formatRepoConfig({
                git: { worktrees: { base: ".claude/worktrees", install: "bun install", plansSync: true } },
            })
        );
        out.log.info("Possible `base` values, with the directory each would produce:");

        for (const preset of presets) {
            out.log.info(`  ${preset.value} -> ${preset.example}`);
        }

        return 1;
    }

    if (loaded.source === "claude" && loaded.path) {
        // `loadRepoConfig` returns the versioned file first, so the local file this wizard writes is never read.
        out.log.error(
            `The worktree policy of this repository is the versioned ${loaded.path}. It shadows the local file this wizard writes, so a change made here would not take effect.`
        );
        out.log.info("Edit that file instead.");
        return 1;
    }

    p.intro(pc.cyan("worktree policy"));

    const current = loaded.config.git?.worktrees;
    let start: WorktreeSection = WORKTREE_DEFAULTS;
    let fields: WorktreeField[] = ["base", "install", "plansSync"];

    if (current) {
        p.note(formatRepoConfig({ git: { worktrees: current } }), `Current (${loaded.path})`);

        const action = await p.select({
            message: "What do you want to do?",
            options: [
                { value: "keep", label: "Keep it", hint: "write nothing" },
                { value: "change", label: "Change fields", hint: "pick which ones" },
                { value: "reset", label: "Reset", hint: "answer every question from the defaults" },
            ],
            initialValue: "keep",
        });

        if (p.isCancel(action) || action === "keep") {
            p.outro("Nothing written.");
            return 0;
        }

        if (action === "change") {
            start = current;
            const picked = await p.multiselect<WorktreeField>({
                message: "Fields to change",
                options: [
                    { value: "base", label: "base", hint: current.base ?? "not set" },
                    { value: "install", label: "install", hint: current.install ?? "not set" },
                    { value: "plansSync", label: "plansSync", hint: String(current.plansSync ?? false) },
                ],
                required: true,
            });

            if (p.isCancel(picked)) {
                p.cancel("Nothing written.");
                return 1;
            }

            fields = picked;
        }
    }

    let base = start.base;
    let install = start.install;
    let plansSync = start.plansSync;

    if (fields.includes("base")) {
        p.note(
            presets.map((preset) => `${pc.bold(preset.value)}\n  ${pc.dim(preset.example)}`).join("\n\n"),
            `Where a worktree for ${pc.bold("feat/login")} would land`
        );

        const picked = await p.select({
            message: "Base directory for new worktrees",
            options: presets.map((preset) => ({ value: preset.value, label: preset.label, hint: preset.example })),
            initialValue: start.base,
        });

        if (p.isCancel(picked)) {
            p.cancel("Nothing written.");
            return 1;
        }

        base = picked;
    }

    if (fields.includes("install")) {
        const typed = await p.text({
            message: "Command to run inside a new worktree (empty to skip)",
            placeholder: "bun install",
            initialValue: start.install ?? "",
            defaultValue: "",
        });

        if (p.isCancel(typed)) {
            p.cancel("Nothing written.");
            return 1;
        }

        install = typed.trim() || undefined;
    }

    if (fields.includes("plansSync")) {
        const confirmed = await p.confirm({
            message: "Copy .claude/plans back to the main checkout after each commit in a worktree?",
            initialValue: start.plansSync ?? true,
        });

        if (p.isCancel(confirmed)) {
            p.cancel("Nothing written.");
            return 1;
        }

        plansSync = confirmed;
    }

    const next: RepoConfig = {
        ...loaded.config,
        git: {
            ...loaded.config.git,
            worktrees: {
                ...(base ? { base } : {}),
                ...(install ? { install } : {}),
                plansSync: plansSync ?? false,
            },
        },
    };

    p.note(formatRepoConfig({ git: { worktrees: next.git?.worktrees } }), "About to write");
    const confirmed = await p.confirm({ message: `Write to ${repoRoot}/.git/genesis-tools.config.json?` });

    if (p.isCancel(confirmed) || !confirmed) {
        p.cancel("Nothing written.");
        return 1;
    }

    const written = await writeLocalRepoConfig(cwd, next);
    p.outro(`Wrote ${written}`);
    return 0;
}

async function runInit(options: WorktreeOptions): Promise<number> {
    const cwd = options.cwd ?? process.cwd();
    const repoRoot = await repoRootOf(cwd);
    const loaded = await loadRepoConfig(cwd);

    let policy: ReturnType<typeof worktreePolicy>;

    try {
        policy = worktreePolicy(loaded.config, repoRoot);
    } catch (err) {
        if (err instanceof WorktreeNotConfiguredError) {
            // The post-checkout hook must never turn an unconfigured repo into a failed
            // checkout, so it reports nothing and leaves the worktree usable.
            if (options.hook) {
                log.debug({ repoRoot }, "worktree init skipped: unconfigured");
                return 0;
            }

            return refuse(repoRoot);
        }

        throw err;
    }

    const git = createGit({ cwd });
    const inWorktree = existsSync(join(cwd, ".git")) && !existsSync(join(cwd, ".git", "HEAD"));

    // Hook mode runs INSIDE the freshly created worktree, so there is nothing to create.
    if (options.hook) {
        if (!inWorktree) {
            return 0;
        }

        return await finishWorktree({ worktreeRoot: cwd, repoRoot, policy, json: false });
    }

    const branch = options.branch ?? (await git.getCurrentBranch());
    const target = join(policy.baseDir, worktreeDirName(branch));

    if (existsSync(target)) {
        out.log.info(`Worktree already exists: ${target}`);
        out.result({ path: target, branch, created: false });
        return 0;
    }

    mkdirSync(policy.baseDir, { recursive: true });
    const addArgs = options.create
        ? ["worktree", "add", "-b", branch, target, options.base ?? "HEAD"]
        : ["worktree", "add", target, branch];
    const added = await git.executor.exec(addArgs);

    if (!added.success) {
        out.log.error(`git worktree add failed: ${added.stderr.trim()}`);
        return 1;
    }

    // post-checkout already ran the install inside the new worktree, so this only reports.
    out.log.success(`Created worktree for ${branch}`);
    out.result({ path: target, branch, created: true });
    return 0;
}

async function finishWorktree(args: {
    worktreeRoot: string;
    repoRoot: string;
    policy: ReturnType<typeof worktreePolicy>;
    json: boolean;
}): Promise<number> {
    if (args.policy.install) {
        out.log.info(`Running ${args.policy.install}`);
        const proc = Bun.spawn(["sh", "-c", args.policy.install], {
            cwd: args.worktreeRoot,
            stdio: [null, null, null],
        });
        const code = await proc.exited;

        if (code !== 0) {
            out.log.warn(`${args.policy.install} exited ${code}; the worktree is usable but not installed`);
        }
    }

    return 0;
}

async function runSyncPlans(options: WorktreeOptions): Promise<number> {
    const cwd = options.cwd ?? process.cwd();
    const repoRoot = await repoRootOf(cwd);
    const loaded = await loadRepoConfig(cwd);

    // The post-commit hook fires in every worktree of every repo that carries it; the config,
    // not the hook, decides whether plans get copied. An explicit CLI call always runs.
    if (options.hook && loaded.config.git?.worktrees?.plansSync !== true) {
        log.debug({ repoRoot }, "worktree sync-plans skipped: plansSync is off");
        return 0;
    }

    const result = syncPlansToMain({ worktreeRoot: cwd, repoRoot });

    if (options.json) {
        out.result(result);
        return 0;
    }

    if (result.copied.length === 0) {
        log.debug({ ...result }, "worktree sync-plans: nothing to copy");
        return 0;
    }

    out.log.success(`Copied ${result.copied.length} plan file(s) to ${result.to}`);
    return 0;
}

export function registerWorktreeCommand(program: Command, _storage: Storage): void {
    const worktree = program.command("worktree").description("worktree creation policy for this repo");

    worktree
        .command("config")
        .description("guided setup for git.worktrees, showing the exact paths each option produces")
        .option("--cwd <path>", "Run as if in this directory")
        .option("--json", "Print the current policy and the presets, write nothing")
        .action(async (options: WorktreeOptions) => {
            process.exitCode = await runConfig(options);
        });

    worktree
        .command("init")
        .description("create or find a worktree for a branch and run the configured install")
        .option("--cwd <path>", "Run as if in this directory")
        .option("--branch <name>", "Branch to check out; defaults to the current branch")
        .option("--create", "Create the branch as well")
        .option("--base <ref>", "Start point for --create")
        .option("--hook", "Internal: called by the post-checkout hook from inside a new worktree")
        .action(async (options: WorktreeOptions) => {
            process.exitCode = await runInit(options);
        });

    worktree
        .command("sync-plans")
        .description("copy this worktree's .claude/plans into the main checkout, never overwriting")
        .option("--cwd <path>", "Run as if in this directory")
        .option("--json", "Print what was copied")
        .option("--hook", "Internal: called by the post-commit hook")
        .action(async (options: WorktreeOptions) => {
            process.exitCode = await runSyncPlans(options);
        });
}

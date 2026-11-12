/**
 * `tools git worktree config|init|sync-plans|backup` — worktree creation policy for this repo.
 *
 * `config` is the guided setup and the only place the policy is written. `init` creates or
 * finds a worktree and runs the configured install. `sync-plans` rescues `.claude/plans`
 * into the main checkout and is what the post-commit hook calls. `backup` saves a linked
 * worktree's commits, uncommitted changes and untracked files, proves the copy, and with
 * `--remove` removes the worktree (core: `@genesiscz/utils/git` `backupWorktree`).
 *
 * `init` refuses to run unconfigured rather than defaulting, because a wrong base directory
 * scatters worktrees across the disk and moving one afterwards means rewriting its gitdir
 * pointer. The refusal names the command that fixes it.
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { isInteractive, suggestCommand } from "@genesiscz/utils/cli";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { ui } from "@genesiscz/utils/cli/ui";
import { formatBytes } from "@genesiscz/utils/format";
import {
    assertLocalRepoConfigReplaceable,
    backupWorktree,
    createGit,
    DEFAULT_WORKTREE_BACKUP_MAX_COPY_BYTES,
    formatRepoConfig,
    loadRepoConfig,
    planWorktreeBackup,
    type RepoConfig,
    type WorktreeBackupPlan,
    type WorktreeBackupResult,
    type WorktreeSection,
    writeLocalRepoConfig,
} from "@genesiscz/utils/git";
import { logger, out } from "@genesiscz/utils/logger";
import * as p from "@genesiscz/utils/prompts/p";
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

    if (loaded.path !== null && loaded.path === loaded.paths.claude) {
        // `loadRepoConfig` returns the versioned file first, so the local file this wizard writes is never read.
        out.log.error(
            `The worktree policy of this repository is the versioned ${loaded.path}. It shadows the local file this wizard writes, so a change made here would not take effect.`
        );
        out.log.info("Edit that file instead.");
        return 1;
    }

    // A local file that does not parse loads as `{}`, and the wizard would write its answers over it.
    // Say so before the first question, not after the last one.
    try {
        assertLocalRepoConfigReplaceable(loaded.paths.gitDir);
    } catch (err) {
        out.log.error(err instanceof Error ? err.message : String(err));
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
            cancel: "back",
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
                cancel: "back",
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
            cancel: "back",
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
            cancel: "back",
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
            cancel: "back",
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
    const confirmed = await p.confirm({
        message: `Write to ${repoRoot}/.git/genesis-tools.config.json?`,
        cancel: "back",
    });

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
    const added = await git.executor.exec(addArgs, {
        timeout: {
            ms: 600_000,
            reason: "a new worktree checks out the whole tree and runs the post-checkout hook, which installs",
        },
    });

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

interface BackupOptions {
    remove?: boolean;
    dryRun?: boolean;
    note?: string;
    maxCopyMb?: string;
    json?: boolean;
}

const KEY_WIDTH = 11;

function printPlan(plan: WorktreeBackupPlan): void {
    const branch = plan.branch?.replace(/^refs\/heads\//, "") ?? null;
    ui.header(`Worktree ${plan.path}`);
    ui.kv("repository", `${plan.repo} (${plan.repoRoot})`, KEY_WIDTH);
    ui.kv("branch", branch ?? "detached HEAD", KEY_WIDTH);
    ui.kv("HEAD", plan.head.slice(0, 10), KEY_WIDTH);
    ui.kv("base", plan.base ? `${plan.base.sha.slice(0, 10)} from ${plan.base.ref}` : "none found", KEY_WIDTH);
    ui.kv(
        "commits",
        `${plan.commits.length} since the base${plan.merges > 0 ? ` (${plan.merges} merge commits skipped)` : ""}, ${plan.unreachable} on no branch, remote or tag`,
        KEY_WIDTH
    );
    ui.kv("changed", `${plan.changed.length} tracked file(s)`, KEY_WIDTH);
    ui.kv("untracked", `${plan.untracked.length} file(s) or folder(s)`, KEY_WIDTH);
    ui.kv(
        "ignored",
        `${plan.ignored.length} kept${plan.ignored.length > 0 ? `: ${plan.ignored.slice(0, 5).join(", ")}${plan.ignored.length > 5 ? ", ..." : ""}` : ""}`,
        KEY_WIDTH
    );
    ui.kv("copy size", formatBytes(plan.copyBytes), KEY_WIDTH);
    ui.kv("locked", plan.locked === null ? "no" : plan.locked || "yes, without a reason", KEY_WIDTH);
}

function printBlockers(blockers: string[]): void {
    if (blockers.length === 0) {
        ui.ok("No blockers.");
        return;
    }

    for (const blocker of blockers) {
        ui.err(blocker);
    }
}

/**
 * Why a backup refused before writing: the plan's blockers, or the refusal itself when no blocker holds it (a backup
 * root inside the worktree is checked after the plan).
 */
export function preWriteReasons(result: {
    plan: Pick<WorktreeBackupPlan, "blockers">;
    refusal: WorktreeBackupResult["refusal"];
}): string[] {
    if (result.plan.blockers.length > 0 || result.refusal === null) {
        return result.plan.blockers;
    }

    return [result.refusal];
}

function printResult(result: WorktreeBackupResult): void {
    printPlan(result.plan);

    if (result.folder === null) {
        printBlockers(preWriteReasons(result));
        return;
    }

    ui.kv("folder", result.folder, KEY_WIDTH);

    if (result.ref !== null) {
        ui.kv("safety ref", result.ref, KEY_WIDTH);
    }

    const tree =
        result.proof.treeMatches === null ? "" : result.proof.treeMatches ? ", tree matches HEAD" : ", tree DIFFERS";
    ui.kv("proof", `uncommitted ${result.proof.uncommitted}; commits ${result.proof.commits}${tree}`, KEY_WIDTH);

    if (result.skipped.length > 0) {
        ui.warn(`Not copied (sockets, fifos, devices): ${result.skipped.join(", ")}`);
    }

    if (result.removed) {
        const branch = result.plan.branch?.replace(/^refs\/heads\//, "");
        ui.ok(`Removed ${result.plan.path}${branch ? `; the branch ${branch} stays in the repository` : ""}.`);
        return;
    }

    if (result.refusal !== null) {
        ui.err(result.refusal);
        return;
    }

    ui.ok("Backed up. The worktree stays (no --remove).");
}

/**
 * The `--max-copy-mb` value in bytes, or null for anything but a plain decimal number of MiB: `Number()` alone reads
 * `""` as 0 and `0x10` as 16. A byte count past `Number.MAX_SAFE_INTEGER` is refused too: a long run of digits reads
 * as Infinity, and an Infinity limit would switch the copy ceiling off.
 */
export function parseMaxCopyMb(value: string | undefined): number | null {
    if (value === undefined) {
        return DEFAULT_WORKTREE_BACKUP_MAX_COPY_BYTES;
    }

    if (!/^(\d+(\.\d*)?|\.\d+)$/.test(value)) {
        return null;
    }

    const bytes = Math.round(Number(value) * 1024 * 1024);
    return Number.isSafeInteger(bytes) ? bytes : null;
}

/**
 * 0 when the backup did what was asked, 2 when it is proven but `--remove` kept the worktree (a change or a process
 * during the backup), 1 for any other refusal: a script can tell a usable backup from a failed one.
 */
export function backupExitCode(result: Pick<WorktreeBackupResult, "refusal" | "proven">): number {
    if (result.refusal === null) {
        return 0;
    }

    return result.proven ? 2 : 1;
}

async function runBackup(path: string, options: BackupOptions): Promise<number> {
    const maxCopyBytes = parseMaxCopyMb(options.maxCopyMb);

    if (maxCopyBytes === null) {
        out.log.error(`--max-copy-mb takes a number of MiB, such as 512; got "${options.maxCopyMb}".`);
        return 1;
    }

    try {
        if (options.dryRun) {
            const plan = await planWorktreeBackup({ path, maxCopyBytes, remove: options.remove });

            if (options.json) {
                out.result(plan);
            } else {
                printPlan(plan);
                printBlockers(plan.blockers);
                ui.dim("Dry run: nothing was written.");
            }

            return plan.blockers.length > 0 ? 1 : 0;
        }

        const result = await backupWorktree({ path, remove: options.remove, note: options.note, maxCopyBytes });

        if (options.json) {
            out.result(result);
        } else {
            printResult(result);
        }

        return backupExitCode(result);
    } catch (err) {
        out.log.error(err instanceof Error ? err.message : String(err));
        return 1;
    }
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

    worktree
        .command("backup")
        .description(
            "back up a linked worktree (commit patches, uncommitted patch, untracked and ignored files), prove it, optionally remove it"
        )
        .argument("<path>", "The linked worktree's folder")
        .option("--remove", "Remove the worktree once the backup is proven and nothing changed")
        .option("--dry-run", "Print the plan and the blockers, write nothing")
        .option("--note <text>", "What the work was, for the backup's README")
        .option("--max-copy-mb <n>", "Refuse when untracked and ignored files to copy exceed this many MiB", "512")
        .option("--json", "Print the plan (with --dry-run) or the result as JSON")
        .action(async (path: string, options: BackupOptions) => {
            process.exitCode = await runBackup(path, options);
        });
}

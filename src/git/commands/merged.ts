/**
 * `tools git merged` — is this branch or worktree already in the base?
 *
 * A verdict by CONTENT, not by sha: squash, rebase and recompose all fool
 * `git branch -d`, `merge-base --is-ancestor`, `git cherry` and `git diff
 * --stat`. See src/git/lib/merged/verdict.ts for the ladder.
 *
 * A plain run deletes nothing. `--prune <ref>` (repeatable) removes only the
 * refs the user names, each re-verified, after one confirmation.
 */

import { type CollectContext, collectRefReport, listAllRefs, type RefReport } from "@app/git/lib/merged/collect";
import { executePrune, type PruneContext, planPrune } from "@app/git/lib/merged/prune";
import * as p from "@clack/prompts";
import { isInteractive, parseNonNegativeInt, suggestCommand } from "@genesiscz/utils/cli";
import {
    BaseNotFoundError,
    branchPolicy,
    createGit,
    type DetectedBase,
    describeBase,
    detectBase,
    getCurrentBranch,
    listWorktrees,
    loadRepoConfig,
    originDriver,
    prBase,
    type RepoConfig,
} from "@genesiscz/utils/git";
import { logger, out } from "@genesiscz/utils/logger";
import type { Storage } from "@genesiscz/utils/storage";
import type { Command } from "commander";
import pc from "picocolors";

const log = logger.scoped("merged").log;
const FILES_SHOWN = 8;

interface Options {
    base?: string;
    pr?: boolean;
    json?: boolean;
    all?: boolean;
    staleDays: string;
    prune: string[];
    remote?: boolean;
    yes?: boolean;
    cwd?: string;
}

function collectRepeatable(value: string, previous: string[]): string[] {
    return [...previous, value];
}

function verdictColor(verdict: RefReport["verdict"]): (s: string) => string {
    if (verdict === "STALE") {
        return pc.magenta;
    }

    if (verdict === "MERGED") {
        return pc.green;
    }

    return verdict === "EMPTY" ? pc.dim : pc.yellow;
}

function flagsOf(r: RefReport): string {
    return [
        r.dirty > 0 ? `dirty:${r.dirty}` : "",
        r.worktree ? "worktree" : "",
        r.unpushed ? `unpushed:${r.unpushed}` : "",
        r.upstreamGone ? "gone" : "",
        r.upstream === null && r.branch ? "no-upstream" : "",
        r.stale ? `stale:${r.ageDays}d` : "",
        r.pr ? `pr#${r.pr.number}:${r.pr.state}` : "",
    ]
        .filter(Boolean)
        .join(" ");
}

export function renderTable(reports: RefReport[], runBase: DetectedBase): string[] {
    const perRefBase = reports.some((r) => r.base.ref !== runBase.ref);
    const width = Math.max(3, ...reports.map((r) => r.label.length));
    const baseHeader = perRefBase ? "BASE".padEnd(24) : "";
    const lines: string[] = [`${"REF".padEnd(width)}  AHEAD BEHIND  VERDICT   HOW       ${baseHeader}FLAGS`];

    for (const r of reports) {
        const base = perRefBase ? `${r.base.ref} (${r.base.source})`.padEnd(24) : "";
        const counts = `${String(r.ahead).padStart(5)} ${String(r.behind).padStart(6)}`;
        const verdict = verdictColor(r.verdict)(r.verdict.padEnd(8));
        lines.push(`${r.label.padEnd(width)}  ${counts}  ${verdict}  ${r.how.padEnd(8)}  ${base}${flagsOf(r)}`);

        for (const f of r.unmerged.slice(0, FILES_SHOWN)) {
            lines.push(
                `${" ".repeat(width)}    ${f.status} ${f.path}  (${f.status} vs merge-base; +${f.insertions}/-${f.deletions} vs ${r.base.ref})`
            );
        }

        if (r.unmerged.length > FILES_SHOWN) {
            lines.push(`${" ".repeat(width)}    … ${r.unmerged.length - FILES_SHOWN} more (use --json for all)`);
        }
    }

    return lines;
}

async function buildContext(opts: Options): Promise<{ ctx: CollectContext; config: RepoConfig }> {
    const cwd = opts.cwd ?? process.cwd();
    const top = await createGit({ cwd }).executor.exec(["rev-parse", "--show-toplevel"]);

    if (!top.success) {
        throw new Error(`Not a git repository: ${cwd}`);
    }

    const repoRoot = top.stdout;
    const loaded = await loadRepoConfig(cwd);

    for (const problem of loaded.problems) {
        out.log.warn(`config ${loaded.path}: ${problem}`);
    }

    const wantDriver = opts.pr === true || opts.remote === true;
    const driver = wantDriver ? await originDriver(repoRoot) : null;

    if (wantDriver && !driver) {
        out.log.warn("no origin driver for this remote; PR corroboration is off");
    }

    const base = await detectBase({ cwd: repoRoot, flag: opts.base, config: loaded.config });
    const ctx: CollectContext = {
        repoRoot,
        worktrees: await listWorktrees(repoRoot),
        base,
        driver,
        wantPr: opts.pr === true,
        staleDays: parseNonNegativeInt(opts.staleDays, "--stale-days"),
        nowEpoch: Math.floor(Date.now() / 1000),
    };
    return { ctx, config: loaded.config };
}

async function reportRefs({
    ctx,
    refs,
    opts,
}: {
    ctx: CollectContext;
    refs: string[];
    opts: Options;
}): Promise<number> {
    const reports: RefReport[] = [];
    const errors: string[] = [];
    const spinner = opts.json ? null : out.spinner();
    spinner?.start(`checking ${refs.length} ref(s) against ${ctx.base.ref}`);

    const driver = ctx.driver;

    if (opts.pr && driver && !opts.base) {
        ctx.baseFor = (branch) => prBase({ cwd: ctx.repoRoot, branch, driver });
    }

    for (const [i, ref] of refs.entries()) {
        spinner?.message(`${i + 1}/${refs.length} ${ref}`);

        try {
            reports.push(await collectRefReport(ctx, ref));
        } catch (err) {
            log.warn({ ref, error: err }, "merged: ref skipped");
            errors.push(`${ref}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    spinner?.stop(`${reports.length} ref(s) checked`);

    if (opts.json) {
        out.result({ base: ctx.base, reports, errors });
    } else {
        out.println(`base: ${describeBase(ctx.base)}\n`);

        if (reports.length > 0) {
            out.println(renderTable(reports, ctx.base).join("\n"));
        }

        for (const e of errors) {
            out.println(pc.red(`error: ${e}`));
        }

        const stale = reports.filter((r) => r.verdict === "STALE" && r.dirty === 0);

        if (stale.length > 0) {
            out.println(
                "\nstale drafts (nothing of theirs landed as-is, but the base rewrote EVERY file they touch — an older copy of work that moved on):"
            );

            for (const r of stale) {
                out.println(`  ${r.label}  ${r.unmerged.length} file(s), all superseded on ${r.base.ref}`);
            }

            out.println(
                `  ${suggestCommand("tools git merged", {
                    subcommand: ["merged"],
                    remove: ["--all", "--pr", "--json", ...stale.map((r) => r.ref)],
                    add: stale.flatMap((r) => ["--prune", r.ref]),
                })}`
            );
        }

        const removable = reports.filter((r) => r.commands.length > 0);

        if (removable.length > 0) {
            out.println("\nsafe to remove (verdict MERGED or EMPTY, worktree clean) — not run by this command:");
            out.println(
                `  ${suggestCommand("tools git merged", {
                    subcommand: ["merged"],
                    remove: ["--all", "--pr", "--json", ...removable.map((r) => r.ref)],
                    add: removable.flatMap((r) => ["--prune", r.ref]),
                })}`
            );
        }
    }

    const bad = reports.some((r) => r.verdict === "UNMERGED" || r.dirty > 0) || errors.length > 0;
    return bad ? 1 : 0;
}

async function pruneRefs({
    ctx,
    config,
    opts,
}: {
    ctx: CollectContext;
    config: RepoConfig;
    opts: Options;
}): Promise<number> {
    const pruneCtx: PruneContext = {
        ...ctx,
        remote: opts.remote === true,
        currentBranch: await getCurrentBranch(opts.cwd ?? process.cwd()),
        policyFor: (branch) => branchPolicy(config, branch),
    };
    const driver = ctx.driver;

    if (opts.pr && driver && !opts.base) {
        pruneCtx.baseFor = (branch) => prBase({ cwd: ctx.repoRoot, branch, driver });
    }

    const { plans, refusals } = await planPrune(pruneCtx, opts.prune);

    out.println(`base: ${describeBase(ctx.base)}\n`);

    if (ctx.base.source === "inferred") {
        out.log.warn(
            `base was inferred (${ctx.base.detail}); every verdict below depends on it, pass --base to pin it`
        );
    }

    for (const r of refusals) {
        out.println(pc.red(`refused ${r.ref}: ${r.reason}`));
    }

    if (plans.length === 0) {
        out.log.info("Nothing to prune.");
        return refusals.length > 0 ? 1 : 0;
    }

    out.println("plan:");

    for (const plan of plans) {
        const parts: string[] = [];

        if (plan.worktreePath) {
            parts.push(`remove worktree ${plan.worktreePath}`);
        }

        if (plan.branch && plan.tipSha) {
            const why = `${plan.report.verdict} by ${plan.report.how}`;
            parts.push(`delete branch ${plan.branch} (${plan.tipSha.slice(0, 9)}, ${why})`);
        }

        if (plan.remoteBranch) {
            parts.push(`delete origin/${plan.remoteBranch}`);
        }

        out.println(`  ${plan.ref}: ${parts.join("; ")}`);

        for (const w of plan.warnings) {
            out.println(pc.yellow(`    ⚠ ${w}`));
        }
    }

    if (!opts.yes) {
        if (!isInteractive()) {
            out.log.error("Non-interactive: pass --yes once you have read the list a plain run printed.");
            out.log.info(suggestCommand("tools git merged", { subcommand: ["merged"], add: ["--yes"] }));
            return 2;
        }

        const ok = await p.confirm({ message: `Remove ${plans.length} ref(s) as listed?`, initialValue: false });

        if (p.isCancel(ok) || !ok) {
            out.log.info("Cancelled. Nothing removed.");
            return 1;
        }
    }

    const outcomes = await executePrune(pruneCtx, plans);
    let failed = 0;

    for (const o of outcomes) {
        if (o.removedWorktree) {
            out.log.success(`removed worktree ${o.removedWorktree}`);
        }

        if (o.deletedBranch) {
            const restore = `restore: git branch ${o.deletedBranch.name} ${o.deletedBranch.sha}`;
            out.log.success(`deleted ${o.deletedBranch.name} ${pc.dim(`(${restore})`)}`);
        }

        if (o.deletedRemote) {
            // A remote branch has no reflog to fall back on, so the restore push is the only
            // way back; print it even when the local branch was deleted in the same step.
            const restore = o.deletedRemote.sha
                ? ` ${pc.dim(`(restore: git push origin ${o.deletedRemote.sha}:refs/heads/${o.deletedRemote.name})`)}`
                : "";
            out.log.success(`deleted origin/${o.deletedRemote.name}${restore}`);
        }

        for (const f of o.failures) {
            failed++;
            out.log.error(`${o.ref}: ${f}`);
        }
    }

    return failed > 0 || refusals.length > 0 ? 1 : 0;
}

async function runMerged(refs: string[], opts: Options): Promise<number> {
    const { ctx, config } = await buildContext(opts);

    if (opts.prune.length > 0) {
        return pruneRefs({ ctx, config, opts });
    }

    const targets = opts.all ? [...refs, ...(await listAllRefs(ctx))] : refs;

    if (targets.length === 0) {
        out.log.error("Nothing to check: name refs or worktree paths, or pass --all.");
        out.log.info(suggestCommand("tools git merged", { subcommand: ["merged"], add: ["--all"] }));
        return 2;
    }

    return reportRefs({ ctx, refs: [...new Set(targets)], opts });
}

export function registerMergedCommand(parent: Command, _storage: Storage): void {
    parent
        .command("merged [refs...]")
        .description("Is a branch or worktree already in the base? A verdict by content, not by sha")
        .option("-b, --base <ref>", "Base to judge against (default: config mainPrBranch, else origin HEAD)")
        .option("--pr", "Corroborate with each branch's PR/MR and judge stacked children against their PR target")
        .option("--json", "Emit the full report as JSON (never deletes)")
        .option("--all", "Every local branch except the base, plus every detached worktree")
        .option("-d, --stale-days <n>", "Flag branches with no commit newer than this many days", "90")
        .option(
            "--prune <ref>",
            "Remove this ref (repeatable); only refs named here, each re-verified",
            collectRepeatable,
            []
        )
        .option("--remote", "With --prune: also delete origin/<branch> when it is the upstream and no PR is open")
        .option("--yes", "With --prune: skip the confirmation (you have read the list a plain run printed)")
        .option("-C, --cwd <path>", "Run against the repository at this path")
        .action(async (refs: string[], options: Options) => {
            try {
                process.exitCode = await runMerged(refs, options);
            } catch (err) {
                if (err instanceof BaseNotFoundError) {
                    out.log.error(err.message);
                    process.exitCode = 2;
                    return;
                }

                log.error({ error: err }, "merged failed");
                out.log.error(err instanceof Error ? err.message : String(err));
                process.exitCode = 1;
            }
        });
}

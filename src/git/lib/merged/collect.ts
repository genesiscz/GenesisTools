import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { BaseSource, DetectedBase, OriginDriver, PrInfo, WorktreeInfo } from "@genesiscz/utils/git";
import { blobMap, createGit } from "@genesiscz/utils/git";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { contentVerdict, type How, historicBlobsOf, quickVerdict, type Verdict } from "./verdict";

const SECONDS_PER_DAY = 86_400;

export interface UnmergedFile {
    path: string;
    status: string;
    insertions: number;
    deletions: number;
}

export interface RefReport {
    /** The argument as given. */
    ref: string;
    /** Short label for tables: the branch, or the worktree path relative to the repo. */
    label: string;
    /** How the argument was understood: a worktree path, a local branch, or any other commit-ish. */
    kind: "path" | "branch" | "ref";
    branch: string | null;
    worktree: string | null;
    /** `status --porcelain` entries in the worktree; 0 when there is no worktree. */
    dirty: number;
    ahead: number;
    behind: number;
    cherryPlus: number;
    verdict: Verdict;
    how: How;
    /** Paths changed since the merge-base; null when the content tier did not run. */
    touched: number | null;
    unmerged: UnmergedFile[];
    upstream: string | null;
    /** Commits on the branch the upstream lacks; null without an upstream. */
    unpushed: number | null;
    upstreamGone: boolean;
    ageDays: number;
    stale: boolean;
    pr: PrInfo | null;
    base: { ref: string; source: BaseSource };
    /** Exact removal commands for a clean MERGED/EMPTY ref; a plain run never executes them. */
    commands: string[];
}

export interface ResolvedRef {
    ref: string;
    label: string;
    kind: "path" | "branch" | "ref";
    branch: string | null;
    worktree: WorktreeInfo | null;
    /** The revision to judge: the branch, or the worktree's HEAD when detached. */
    target: string;
}

export interface CollectContext {
    repoRoot: string;
    worktrees: WorktreeInfo[];
    base: DetectedBase;
    driver: OriginDriver | null;
    wantPr: boolean;
    staleDays: number;
    nowEpoch: number;
    /** A per-branch base (its PR target) that overrides `base`; null keeps the run's base. */
    baseFor?: (branch: string) => Promise<DetectedBase | null>;
    /** Filled on first use: one path → blob map per base ref a run judges against. */
    baseBlobs?: Map<string, Map<string, string>>;
}

function samePath(a: string, b: string): boolean {
    const norm = (p: string): string => {
        try {
            return realpathSync(p);
        } catch (err) {
            logger.debug({ err, path: p }, "merged: realpath failed, comparing as given");
            return resolve(p);
        }
    };

    return norm(a) === norm(b);
}

export function isMainWorktree(wt: WorktreeInfo, repoRoot: string): boolean {
    return wt.isMain || samePath(wt.path, repoRoot);
}

/**
 * What a ref argument names. A worktree path wins over a branch of the same
 * spelling (the row says so); a branch is judged as itself; anything else
 * must resolve to a commit (a tag, a sha, `origin/x`).
 */
export async function resolveRef(ctx: CollectContext, ref: string): Promise<ResolvedRef> {
    const git = createGit({ cwd: ctx.repoRoot });

    if (existsSync(ref)) {
        const wt = ctx.worktrees.find((w) => samePath(w.path, ref));

        if (wt) {
            const abs = resolve(ref);
            const label = abs.startsWith(`${ctx.repoRoot}/`) ? abs.slice(ctx.repoRoot.length + 1) : ref;
            return { ref, label, kind: "path", branch: wt.branch, worktree: wt, target: wt.branch ?? wt.head };
        }
    }

    if (await git.branchExists(ref)) {
        const wt = ctx.worktrees.find((w) => w.branch === ref) ?? null;
        return { ref, label: ref, kind: "branch", branch: ref, worktree: wt, target: ref };
    }

    if (await git.refExists(`${ref}^{commit}`)) {
        return { ref, label: ref, kind: "ref", branch: null, worktree: null, target: ref };
    }

    throw new Error(`${ref} is neither a worktree path, a local branch, nor a commit`);
}

async function baseBlobsOf({
    ctx,
    git,
    baseRef,
}: {
    ctx: CollectContext;
    git: ReturnType<typeof createGit>;
    baseRef: string;
}): Promise<Map<string, string>> {
    ctx.baseBlobs ??= new Map();
    const cached = ctx.baseBlobs.get(baseRef);

    if (cached) {
        return cached;
    }

    const blobs = blobMap(await git.lsTree({ ref: baseRef }));
    ctx.baseBlobs.set(baseRef, blobs);
    return blobs;
}

/**
 * One report for one ref. About ten git calls; the content tier only runs
 * when the cheap tiers cannot decide. `ctx.baseFor` lets a run judge a branch
 * against its own base (its PR target) instead of the run's base.
 */
export async function collectRefReport(ctx: CollectContext, ref: string): Promise<RefReport> {
    const git = createGit({ cwd: ctx.repoRoot });
    const resolved = await resolveRef(ctx, ref);
    const { branch, worktree, target } = resolved;
    const base = (branch && ctx.baseFor ? await ctx.baseFor(branch) : null) ?? ctx.base;

    const dirty = worktree ? (await git.status({ cwd: worktree.path })).entries.length : 0;
    const mergeBase = await git.mergeBase(base.ref, target);
    const { ahead, behind } = await git.aheadBehind(base.ref, target);
    const atBase = (await git.getSha(target)) === (await git.getSha(base.ref));
    const cherryPlus = (await git.cherry(base.ref, target)).filter((c) => !c.present).length;
    const epoch = await git.lastCommitEpoch(target);
    const ageDays = epoch > 0 ? Math.floor((ctx.nowEpoch - epoch) / SECONDS_PER_DAY) : 0;

    const refInfo = branch ? (await git.refs([`refs/heads/${branch}`]))[0] : undefined;
    const upstream = refInfo?.upstream ?? null;
    const upstreamGone = refInfo?.upstreamGone ?? false;
    const unpushed = upstream && !upstreamGone ? (refInfo?.ahead ?? null) : null;

    let decision = quickVerdict({ ahead, atBase, cherryPlus });
    let touched: number | null = null;
    const unmerged: UnmergedFile[] = [];

    if (!decision) {
        const changes = await git.nameStatus({ from: mergeBase, to: target });
        touched = changes.length;
        const livePaths = changes.filter((c) => c.status !== "D").map((c) => c.path);
        decision = contentVerdict({
            changes,
            branchBlobs: blobMap(await git.lsTree({ ref: target })),
            baseBlobs: await baseBlobsOf({ ctx, git, baseRef: base.ref }),
            historicBlobs: historicBlobsOf(
                livePaths.length > 0
                    ? await git.rawChanges({ range: `${mergeBase}..${base.ref}`, paths: livePaths })
                    : []
            ),
        });
        const missing = decision.unmerged.map((u) => u.path);
        const stats = new Map(
            (missing.length > 0 ? await git.numstat({ from: base.ref, to: target, paths: missing }) : []).map((s) => [
                s.path,
                s,
            ])
        );

        for (const u of decision.unmerged) {
            const s = stats.get(u.path);
            unmerged.push({
                path: u.path,
                status: u.status,
                insertions: s?.insertions ?? 0,
                deletions: s?.deletions ?? 0,
            });
        }
    }

    const pr = ctx.wantPr && ctx.driver && branch ? (await ctx.driver.prForHead(branch)).pr : null;
    const commands: string[] = [];

    if (decision.verdict !== "UNMERGED" && dirty === 0) {
        if (worktree && !isMainWorktree(worktree, ctx.repoRoot)) {
            commands.push(`git worktree remove ${SafeJSON.stringify(worktree.path)}`);
        }

        if (branch) {
            commands.push(`git branch -D ${branch}`);
        }
    }

    logger.debug(
        {
            ref,
            target,
            base: base.ref,
            verdict: decision.verdict,
            how: decision.how,
            ahead,
            behind,
            cherryPlus,
            touched,
        },
        "merged: verdict"
    );

    return {
        ref,
        label: resolved.label,
        kind: resolved.kind,
        branch,
        worktree: worktree?.path ?? null,
        dirty,
        ahead,
        behind,
        cherryPlus,
        verdict: decision.verdict,
        how: decision.how,
        touched,
        unmerged,
        upstream,
        unpushed,
        upstreamGone,
        ageDays,
        stale: ageDays >= ctx.staleDays,
        pr,
        base: { ref: base.ref, source: base.source },
        commands,
    };
}

/** `--all`: every local branch except the base and master/main, plus every detached non-main worktree. */
export async function listAllRefs(ctx: CollectContext): Promise<string[]> {
    const git = createGit({ cwd: ctx.repoRoot });
    const baseBranch = ctx.base.ref.replace(/^origin\//, "");
    const refs = (await git.listLocalBranchNames()).filter((b) => b !== baseBranch && b !== "master" && b !== "main");

    for (const wt of ctx.worktrees) {
        if (!wt.branch && !isMainWorktree(wt, ctx.repoRoot)) {
            refs.push(wt.path);
        }
    }

    return refs;
}

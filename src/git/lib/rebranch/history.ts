/**
 * The git reads behind `rebranch plan`, `apply` and `verify`: the source's commits since the
 * merge-base with their paths, and the trees the split proof compares. Typed readers only
 * (`createGit()` over `porcelain`), so no git output is parsed here by hand.
 */

import type { createGit, TreeEntry } from "@genesiscz/utils/git";
import { logger } from "@genesiscz/utils/logger";
import type { HistoryCommit } from "./classify";
import type { ResolvedGroup, ResolvedPlan } from "./plan";
import { type EntryMap, type VerifyReport, verifySplit } from "./verify";

type Git = ReturnType<typeof createGit>;

export interface SourceCommit extends HistoryCommit {
    parents: string[];
}

export interface SourceHistory {
    source: string;
    sourceSha: string;
    base: string;
    baseSha: string;
    mergeBase: string;
    /** Oldest first. */
    commits: SourceCommit[];
    /** Merge commits in the range; a non-empty list stops plan and apply. */
    merges: SourceCommit[];
    /** Commits the base gained since the merge-base. */
    baseAhead: number;
}

export async function resolveCommit(git: Git, ref: string): Promise<string> {
    const res = await git.executor.exec(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);

    if (!res.success || !res.stdout) {
        throw new Error(`${ref} does not resolve to a commit`);
    }

    return res.stdout;
}

export async function readSourceHistory(
    git: Git,
    { source, base }: { source: string; base: string }
): Promise<SourceHistory> {
    const sourceSha = await resolveCommit(git, source);
    const baseSha = await resolveCommit(git, base);
    const mergeBase = await git.mergeBase(baseSha, sourceSha);
    const range = `${mergeBase}..${sourceSha}`;
    const log = await git.log({ range, reverse: true });
    const changes = await git.rawChanges({ range, renames: false });
    const pathsBy = new Map<string, Set<string>>();

    for (const change of changes) {
        const set = pathsBy.get(change.commit) ?? new Set<string>();
        set.add(change.path);
        pathsBy.set(change.commit, set);
    }

    const commits: SourceCommit[] = log.map((c) => ({
        sha: c.sha,
        subject: c.subject,
        parents: c.parents,
        paths: [...(pathsBy.get(c.sha) ?? [])].sort(),
    }));
    const baseAhead = await git.countCommits(mergeBase, baseSha);
    const history: SourceHistory = {
        source,
        sourceSha,
        base,
        baseSha,
        mergeBase,
        commits,
        merges: commits.filter((c) => c.parents.length > 1),
        baseAhead,
    };

    logger.debug(
        { source, sourceSha, base, baseSha, mergeBase, commits: commits.length, baseAhead },
        "rebranch: source history read"
    );
    return history;
}

/** The refusal `plan` and `apply` print for merge commits in the range, with the way out. */
export function mergeRefusal(history: SourceHistory): string {
    const list = history.merges.map((m) => `${m.sha.slice(0, 9)} ${m.subject}`).join("\n  ");
    return [
        `${history.merges.length} merge commit(s) between the merge-base and ${history.source}:`,
        `  ${list}`,
        `A cherry-pick cannot carry a merge without a mainline parent, and \`-m 1\` would move its`,
        `resolution as an unlabelled diff. Linearise ${history.source} first (git rebase ${history.base}`,
        "in a worktree, or the recommit flow), then plan again.",
    ].join("\n");
}

export function entryMap(entries: TreeEntry[]): EntryMap {
    const map: EntryMap = new Map();

    for (const e of entries) {
        if (e.type !== "tree") {
            map.set(e.path, { mode: e.mode, sha: e.sha });
        }
    }

    return map;
}

export interface SplitTrees {
    expected: EntryMap;
    base: EntryMap;
    branches: Record<string, EntryMap>;
    unverifiable: string[];
    /** How the expected tree was found, for the report. */
    expectedFrom: string;
}

export interface ReadSplitTreesOptions {
    git: Git;
    sourceSha: string;
    baseSha: string;
    mergeBase: string;
    groups: ResolvedGroup[];
}

/**
 * When the group branches start where the source forked, the expected tree is the source tip.
 * When the base moved, it is the source merged onto the base (`git merge-tree`), because every
 * group branch carries the base's newer commits too; paths that merge conflicts on cannot be
 * settled by a blob comparison and are returned as unverifiable.
 */
export async function readSplitTrees(opts: ReadSplitTreesOptions): Promise<SplitTrees> {
    const { git, sourceSha, baseSha, mergeBase, groups } = opts;
    let expectedRef = sourceSha;
    let unverifiable: string[] = [];
    let expectedFrom = `the source tip ${sourceSha.slice(0, 9)}`;

    if (baseSha !== mergeBase) {
        const merged = await git.mergeTree(baseSha, sourceSha);
        expectedRef = merged.tree;
        unverifiable = merged.conflictedFiles;
        expectedFrom = `the source merged onto the moved base ${baseSha.slice(0, 9)} (git merge-tree)`;
    }

    const branches: Record<string, EntryMap> = {};
    const missing: string[] = [];

    for (const g of groups) {
        const exists = await git.branchExists(g.branch);

        if (!exists) {
            missing.push(g.branch);
            continue;
        }

        branches[g.name] = entryMap(await git.lsTree({ ref: `refs/heads/${g.branch}` }));
    }

    if (missing.length > 0) {
        throw new Error(`group branch(es) missing: ${missing.join(", ")}`);
    }

    return {
        expected: entryMap(await git.lsTree({ ref: expectedRef })),
        base: entryMap(await git.lsTree({ ref: baseSha })),
        branches,
        unverifiable,
        expectedFrom,
    };
}

export interface ProveSplitOptions {
    git: Git;
    plan: ResolvedPlan;
    history: SourceHistory;
    /** The commit the group branches start from; the base tip when apply ran. */
    baseSha: string;
}

export interface SplitProof {
    report: VerifyReport;
    expectedFrom: string;
}

/** Read the trees and judge the split: the step that `apply` ends with and `verify` runs alone. */
export async function proveSplit({ git, plan, history, baseSha }: ProveSplitOptions): Promise<SplitProof> {
    const trees = await readSplitTrees({
        git,
        sourceSha: history.sourceSha,
        baseSha,
        mergeBase: history.mergeBase,
        groups: plan.groups,
    });
    const report = verifySplit({
        groups: plan.groups,
        history: history.commits,
        skip: plan.skip,
        expected: trees.expected,
        base: trees.base,
        branches: trees.branches,
        unverifiable: trees.unverifiable,
    });

    logger.debug(
        {
            ok: report.ok,
            paths: report.paths.length,
            failing: report.paths.filter((p) => p.status !== "ok" && p.status !== "dropped").length,
            extra: report.extra.length,
        },
        "rebranch: split verified"
    );
    return { report, expectedFrom: trees.expectedFrom };
}

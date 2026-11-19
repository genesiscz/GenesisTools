#!/usr/bin/env bun
/**
 * Refuses a push that rewrites a branch while an open pull request is stacked on it and still carries the old commits.
 *
 *   <pre-push stdin> | bun scripts/git/stack-children-guard.ts <remote name>
 *
 * Observed 2026-11-19: a merge train rebuilt three stacked branches on master by hand (cherry-picks and
 * `push --force-with-lease`) and never looked for pull requests based on the last of them. The child PR kept the old
 * copies of every parent commit, and GitHub showed it as 133 commits and 368 files instead of 8 commits.
 * `tools github merge --rebase` and `tools git rebase-cascade` move children; a hand-made rebuild does not.
 *
 * A child counts as handled when the same push also moves its branch onto the new parent head (`git push origin
 * parent child`), or when its branch no longer holds the old parent head. GT_ALLOW_ORPHANED_CHILD_PRS=1 skips the
 * guard for one push. Without `gh`, or when GitHub does not answer, the guard warns and lets the push go.
 */

import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";

const ZERO = "0000000000000000000000000000000000000000";

export interface RefUpdate {
    localSha: string;
    remoteRef: string;
    remoteSha: string;
}

export interface ChildPr {
    number: number;
    title: string;
    headRefName: string;
    headSha: string;
}

interface GhPrRow {
    number: number;
    title: string;
    headRefName: string;
    headRefOid: string;
}

export interface OrphanedChild {
    parent: string;
    child: ChildPr;
}

export function parsePrePushLines(text: string): RefUpdate[] {
    return text
        .split("\n")
        .map((line) => line.trim().split(/\s+/))
        .filter((parts) => parts.length === 4)
        .map(([, localSha, remoteRef, remoteSha]) => ({ localSha, remoteRef, remoteSha }));
}

export function branchOf(remoteRef: string): string | null {
    return remoteRef.startsWith("refs/heads/") ? remoteRef.slice("refs/heads/".length) : null;
}

/**
 * The children that keep the old commits of a rewritten parent. `isAncestor(a, b)` answers whether commit a is in b.
 */
export function findOrphanedChildren(
    updates: RefUpdate[],
    childrenOf: (branch: string) => ChildPr[],
    isAncestor: (ancestor: string, descendant: string) => boolean
): OrphanedChild[] {
    const pushed = new Map<string, RefUpdate>();
    for (const update of updates) {
        const branch = branchOf(update.remoteRef);
        if (branch) {
            pushed.set(branch, update);
        }
    }

    const orphaned: OrphanedChild[] = [];
    for (const [parent, update] of pushed) {
        if (update.localSha === ZERO || update.remoteSha === ZERO) {
            continue;
        }

        if (isAncestor(update.remoteSha, update.localSha)) {
            continue;
        }

        for (const child of childrenOf(parent)) {
            const moved = pushed.get(child.headRefName);
            if (moved && moved.localSha !== ZERO) {
                if (!isAncestor(update.remoteSha, moved.localSha) && isAncestor(update.localSha, moved.localSha)) {
                    continue;
                }
            } else if (!isAncestor(update.remoteSha, child.headSha)) {
                continue;
            }

            orphaned.push({ parent, child });
        }
    }

    return orphaned;
}

function run(args: string[]): { ok: boolean; out: string } {
    const proc = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
    return { ok: proc.exitCode === 0, out: proc.stdout.toString() };
}

function hasCommit(sha: string): boolean {
    return run(["git", "cat-file", "-e", `${sha}^{commit}`]).ok;
}

async function main(): Promise<number> {
    if (env.isFlag("GT_ALLOW_ORPHANED_CHILD_PRS")) {
        return 0;
    }

    const remote = process.argv[2] ?? "origin";
    const updates = parsePrePushLines(await Bun.stdin.text());
    const rewritten = updates.filter(
        (u) =>
            branchOf(u.remoteRef) &&
            u.localSha !== ZERO &&
            u.remoteSha !== ZERO &&
            hasCommit(u.remoteSha) &&
            !run(["git", "merge-base", "--is-ancestor", u.remoteSha, u.localSha]).ok
    );
    if (rewritten.length === 0) {
        return 0;
    }

    const children = new Map<string, ChildPr[]>();
    for (const update of rewritten) {
        const parent = branchOf(update.remoteRef);
        if (!parent) {
            continue;
        }

        const listed = run([
            "gh",
            "pr",
            "list",
            "--state",
            "open",
            "--base",
            parent,
            "--json",
            "number,title,headRefName,headRefOid",
        ]);
        if (!listed.ok) {
            process.stderr.write(
                `⚠ stack guard: could not list the PRs based on ${parent}; children were not checked\n`
            );
            continue;
        }

        const rows: GhPrRow[] = SafeJSON.parse(listed.out, { strict: true });
        const list = rows.map((r) => ({
            number: r.number,
            title: r.title,
            headRefName: r.headRefName,
            headSha: r.headRefOid,
        }));
        for (const child of list) {
            if (!hasCommit(child.headSha)) {
                run(["git", "fetch", "--quiet", remote, child.headSha]);
            }
        }
        children.set(parent, list);
    }

    const isAncestor = (a: string, b: string): boolean =>
        hasCommit(a) && hasCommit(b) && run(["git", "merge-base", "--is-ancestor", a, b]).ok;
    const orphaned = findOrphanedChildren(updates, (b) => children.get(b) ?? [], isAncestor);
    if (orphaned.length === 0) {
        return 0;
    }

    const lines = [
        "✗ This push rewrites a branch that open pull requests are stacked on, and they still carry its old commits.",
        "  GitHub would show each of them with every old parent commit as its own (2026-11-19: 133 commits instead of 8).",
        ...orphaned.map(
            ({ parent, child }) =>
                `  - #${child.number} (${child.title}) on ${parent}: its branch ${child.headRefName} holds the old head`
        ),
        "  Rebuild each child on the new parent head and push it in the same command:",
        "    git push --force-with-lease origin <parent> <child>   (or: tools git rebase-cascade <parent>)",
        "  A child rebuilt and pushed before the parent also passes. GT_ALLOW_ORPHANED_CHILD_PRS=1 skips this check once.",
    ];
    process.stderr.write(`${lines.join("\n")}\n`);
    return 1;
}

if (import.meta.main) {
    process.exit(await main());
}

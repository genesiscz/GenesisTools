/**
 * Moves git does not report: a folder moved in Finder or by an agent, without `git mv`. Git pairs a rename only
 * when both sides are in the index, so the old paths read as deleted and the new ones as untracked (2026-10-25: 147
 * files of a moved vault folder listed as deleted). A deleted file whose exact content is now an untracked file is
 * that move.
 *
 * The same rule lives in GenesisKit (`Diff/Source/GitWorktreeRenames.swift`), for the apps' repository panel and
 * diffs. `GenesisKitFixtures/Git/contract-worktree-renames.json` holds the cases both implementations pass.
 *
 * Cost on a vault with 650 deleted and 4,834 untracked files: one `cat-file --batch-check` for the deleted blobs'
 * sizes, an `lstat` per untracked file, and `hash-object` only for files whose size equals a deleted blob's (about
 * 50 ms), where git's own detection through a scratch index (`add -N`, then `status`) took 3.9 s.
 */

import { lstatSync } from "node:fs";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";
import type { StatusEntry } from "./porcelain";

export interface WorktreeSide {
    path: string;
    oid: string;
}

export interface WorktreeRename {
    old: string;
    new: string;
}

/** The empty blob in SHA-1 and SHA-256 repositories: every empty file shares it, so it proves no move. */
const EMPTY_BLOBS = new Set([
    "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391",
    "473a0f4c3be8a93681a267e3b1e9a7dcda1185436fe141f7749120a303721813",
]);

function compareBytes(a: string, b: string): number {
    return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function commonCount(a: string[], b: string[]): number {
    let count = 0;

    while (count < a.length && count < b.length && a[count] === b[count]) {
        count++;
    }

    return count;
}

/** Lexicographic comparison of two score tuples: negative when `a` scores lower. */
function compareScores(a: number[], b: number[]): number {
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) {
            return a[i] - b[i];
        }
    }

    return 0;
}

/**
 * Pairs each deleted file with an untracked file of the same blob. Among several, the one whose path is most alike
 * wins: the same file name first, then the most equal trailing folders, then the most equal leading ones, then byte
 * order. Deleted files are taken in byte order; each untracked file pairs at most once.
 */
export function pairWorktreeRenames(deleted: WorktreeSide[], untracked: WorktreeSide[]): WorktreeRename[] {
    const byOid = new Map<string, string[]>();

    for (const side of untracked) {
        if (EMPTY_BLOBS.has(side.oid)) {
            continue;
        }

        const list = byOid.get(side.oid) ?? [];
        list.push(side.path);
        byOid.set(side.oid, list);
    }

    const taken = new Set<string>();
    const pairs: WorktreeRename[] = [];

    for (const side of [...deleted].sort((a, b) => compareBytes(a.path, b.path))) {
        const candidates = EMPTY_BLOBS.has(side.oid) ? undefined : byOid.get(side.oid);

        if (!candidates) {
            continue;
        }

        const old = side.path.split("/");
        let best: { path: string; score: number[] } | null = null;

        for (const path of candidates) {
            if (taken.has(path)) {
                continue;
            }

            const next = path.split("/");
            const score = [
                old.at(-1) === next.at(-1) ? 1 : 0,
                commonCount([...old].reverse(), [...next].reverse()),
                commonCount(old, next),
            ];

            if (best) {
                const order = compareScores(score, best.score);

                if (order < 0 || (order === 0 && compareBytes(path, best.path) >= 0)) {
                    continue;
                }
            }

            best = { path, score };
        }

        if (best) {
            taken.add(best.path);
            pairs.push({ old: side.path, new: best.path });
        }
    }

    return pairs;
}

async function runGit({ root, args, input }: { root: string; args: string[]; input: string }): Promise<string | null> {
    const proc = Bun.spawn(["git", "-C", root, ...args], {
        stdin: new TextEncoder().encode(input),
        stdout: "pipe",
        stderr: "pipe",
        env: { ...env.getProcessEnv(), GIT_OPTIONAL_LOCKS: "0" },
    });
    const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);

    if (code !== 0) {
        logger.debug({ root, args, code, stderr }, "worktree rename query failed");
        return null;
    }

    return stdout;
}

/**
 * The moves among `deleted` (repo-relative paths whose last version is at `revision`: `HEAD`, `""` for the index, or
 * a commit) and `untracked` (repo-relative paths on disk). Reads only what can match.
 */
export async function findWorktreeRenames(opts: {
    root: string;
    deleted: string[];
    untracked: string[];
    revision: string;
}): Promise<WorktreeRename[]> {
    const { root, revision } = opts;
    // A path with a newline cannot travel through the line-based batch commands; it stays as git reports it.
    const deleted = opts.deleted.filter((path) => !path.includes("\n"));

    if (deleted.length === 0 || opts.untracked.length === 0) {
        return [];
    }

    const checked = await runGit({
        root,
        args: ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
        input: deleted.map((path) => `${revision}:${path}\n`).join(""),
    });

    if (checked === null) {
        return [];
    }

    const lines = checked.split("\n");
    const deletedSides: WorktreeSide[] = [];
    const sizes = new Set<number>();

    for (const [index, path] of deleted.entries()) {
        const [oid, type, size] = (lines[index] ?? "").split(" ");
        const bytes = Number(size);

        if (type === "blob" && bytes > 0) {
            deletedSides.push({ path, oid });
            sizes.add(bytes);
        }
    }

    const candidates: string[] = [];

    for (const path of opts.untracked) {
        if (path.includes("\n")) {
            continue;
        }

        try {
            const stat = lstatSync(join(root, path));

            if (stat.isFile() && sizes.has(stat.size)) {
                candidates.push(path);
            }
        } catch (error) {
            logger.debug({ root, path, error }, "worktree rename candidate unavailable");
        }
    }

    if (deletedSides.length === 0 || candidates.length === 0) {
        return [];
    }

    // A leading quote makes git parse a line as a C-quoted path. A relative prefix keeps every path literal.
    const hashed = await runGit({
        root,
        args: ["hash-object", "--stdin-paths"],
        input: candidates.map((path) => `./${path}\n`).join(""),
    });
    const oids = hashed?.split("\n").filter(Boolean) ?? [];

    if (oids.length !== candidates.length) {
        return [];
    }

    return pairWorktreeRenames(
        deletedSides,
        candidates.map((path, index) => ({ path, oid: oids[index] }))
    );
}

/**
 * Status entries with each move paired: the deleted entry becomes a `renamed` entry at the new path (worktree letter
 * `R`, `origPath` the old path), and its untracked twin is dropped.
 */
export function applyWorktreeRenames(entries: StatusEntry[], renames: WorktreeRename[]): StatusEntry[] {
    if (renames.length === 0) {
        return entries;
    }

    // Staged changes still live at the index path, including a staged rename's existing origPath.
    const eligible = new Set(
        entries
            .filter((entry) => entry.kind === "changed" && entry.index === "." && entry.worktree === "D")
            .map((entry) => entry.path)
    );
    const accepted = renames.filter((pair) => eligible.has(pair.old));
    const newByOld = new Map(accepted.map((pair) => [pair.old, pair.new]));
    const news = new Set(accepted.map((pair) => pair.new));
    const result: StatusEntry[] = [];

    for (const entry of entries) {
        if (entry.kind === "untracked" && news.has(entry.path)) {
            continue;
        }

        const next = entry.kind === "changed" && entry.worktree === "D" ? newByOld.get(entry.path) : undefined;
        result.push(
            next ? { ...entry, kind: "renamed", path: next, origPath: entry.path, worktree: "R", score: 100 } : entry
        );
    }

    return result;
}

/** A status's entries with their working-tree moves paired; the deleted side is the index's version. */
export async function pairStatusRenames(root: string, entries: StatusEntry[]): Promise<StatusEntry[]> {
    const renames = await findWorktreeRenames({
        root,
        deleted: entries
            .filter((entry) => entry.kind === "changed" && entry.index === "." && entry.worktree === "D")
            .map((entry) => entry.path),
        untracked: entries.filter((entry) => entry.kind === "untracked").map((entry) => entry.path),
        revision: "",
    });

    return applyWorktreeRenames(entries, renames);
}

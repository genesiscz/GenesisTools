import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { type GitRead, type GitReadCost, readHookStatus, runGitSync } from "./hook-status";
import type { StatusEntry, StatusSummary } from "./porcelain";

export const NARROW_REFUSALS = [
    "unborn-head",
    "staged",
    "unmerged",
    "intent-to-add",
    "gitlink",
    "sparse-index",
    "split-index",
    "no-index-hash",
    "unsupported-status",
    "git-failed",
] as const;
export type NarrowRefusal = (typeof NARROW_REFUSALS)[number];

/** The saved verdict of one worktree: the narrow reads are valid while HEAD and the index hash stay the same. */
export interface NarrowAdmission {
    v: 1;
    head: string;
    indexHash: string;
    admitted: boolean;
    refusal?: NarrowRefusal;
}

const INDEX_HASH_BYTES = 20;

/** The trailing 20 bytes of the index file as hex; null when they are zero or the file cannot be read. */
export function indexHash(gitDir: string): string | null {
    let fd: number | null = null;

    try {
        fd = openSync(join(gitDir, "index"), "r");
        const size = fstatSync(fd).size;

        if (size < INDEX_HASH_BYTES + 12) {
            return null;
        }

        const buffer = Buffer.alloc(INDEX_HASH_BYTES);
        readSync(fd, buffer, 0, INDEX_HASH_BYTES, size - INDEX_HASH_BYTES);

        if (buffer.every((byte) => byte === 0)) {
            return null;
        }

        return buffer.toString("hex");
    } catch {
        // A missing or unreadable index is "no hash": the caller refuses the narrow reads.
        return null;
    } finally {
        if (fd !== null) {
            closeSync(fd);
        }
    }
}

function readText(path: string): string | null {
    try {
        return readFileSync(path, "utf8");
    } catch {
        // An absent ref file is normal (a packed ref); the caller looks in the next place.
        return null;
    }
}

const OID = /^[0-9a-f]{40,64}$/;

/**
 * The commit HEAD names, read from files without a Git process: `HEAD` itself, the loose ref in the worktree's admin
 * folder or the shared one (`commondir`), then `packed-refs`. Null for an unborn HEAD or a shape it cannot read.
 */
export function headOf(gitDir: string): string | null {
    const head = readText(join(gitDir, "HEAD"))?.trim();

    if (!head) {
        return null;
    }

    if (OID.test(head)) {
        return head;
    }

    const ref = /^ref:\s*(\S+)$/.exec(head)?.[1];

    if (!ref) {
        return null;
    }

    const common = readText(join(gitDir, "commondir"))?.trim();
    const commonDir = common ? (isAbsolute(common) ? common : resolve(gitDir, common)) : gitDir;

    for (const dir of new Set([gitDir, commonDir])) {
        const loose = readText(join(dir, ...ref.split("/")))?.trim();

        if (loose && OID.test(loose)) {
            return loose;
        }
    }

    for (const line of (readText(join(commonDir, "packed-refs")) ?? "").split("\n")) {
        const [oid, name] = line.trim().split(" ");

        if (name === ref && oid && OID.test(oid)) {
            return oid;
        }
    }

    return null;
}

/** The first refusal the status entries give, or null when every entry is an unstaged edit, deletion or untracked path. */
function entryRefusal(entries: readonly StatusEntry[]): NarrowRefusal | null {
    for (const entry of entries) {
        if (entry.kind === "unmerged") {
            return "unmerged";
        }

        if (entry.kind === "untracked") {
            continue;
        }

        if (entry.kind !== "changed") {
            return "unsupported-status";
        }

        if (entry.submodule?.startsWith("S")) {
            return "gitlink";
        }

        if (entry.worktree === "A") {
            return "intent-to-add";
        }

        if (entry.index !== ".") {
            return "staged";
        }

        if (entry.worktree !== "M" && entry.worktree !== "D") {
            return "unsupported-status";
        }
    }

    return null;
}

/**
 * Index shapes the narrow reads do not cover, read from files only: a split index keeps `sharedindex.*` beside the
 * index, a sparse checkout keeps `info/sparse-checkout`, and a `.gitmodules` file means the index can hold gitlinks.
 */
function layoutRefusal(root: string, gitDir: string): NarrowRefusal | null {
    if (existsSync(join(gitDir, "info", "sparse-checkout"))) {
        return "sparse-index";
    }

    try {
        if (readdirSync(gitDir).some((name) => name.startsWith("sharedindex."))) {
            return "split-index";
        }
    } catch {
        // An unreadable admin folder answers through the status read, which fails the same way.
    }

    if (existsSync(join(root, ".gitmodules"))) {
        return "gitlink";
    }

    return null;
}

/** One full status plus the index checks. The status is returned, so the caller uses it for this call. */
export function admitWorktree(
    root: string,
    facts: { head: string | null; gitDir: string }
): { admission: NarrowAdmission | null; status: GitRead<StatusSummary> } {
    const before = indexHash(facts.gitDir);
    const status = readHookStatus(root);
    const after = indexHash(facts.gitDir);
    const head = status.ok ? (status.value.branch?.oid ?? facts.head) : facts.head;
    const refuse = (refusal: NarrowRefusal): NarrowAdmission => ({
        v: 1,
        head: head ?? "",
        indexHash: after ?? "",
        admitted: false,
        refusal,
    });

    if (!status.ok) {
        return { admission: refuse("git-failed"), status };
    }

    if (!head || !/^[0-9a-f]{40,64}$/.test(head)) {
        return { admission: refuse("unborn-head"), status };
    }

    if (!after) {
        return { admission: refuse("no-index-hash"), status };
    }

    if (before !== after) {
        // The status read refreshed the index (or another writer did): the hash it was taken against is gone.
        return { admission: null, status };
    }

    const refusal = layoutRefusal(root, facts.gitDir) ?? entryRefusal(status.value.entries);

    if (refusal) {
        return { admission: refuse(refusal), status };
    }

    return { admission: { v: 1, head, indexHash: after, admitted: true }, status };
}

function addCost(a: GitReadCost, b: GitReadCost): GitReadCost {
    return { cpuMs: a.cpuMs + b.cpuMs, wallMs: a.wallMs + b.wallMs, spawns: a.spawns + b.spawns };
}

const NARROW_TRACKED_ARGS = [
    "--no-optional-locks",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.preloadIndex=false",
    "diff",
    "--name-status",
    "-z",
    "--no-renames",
    "--no-relative",
    "--no-ext-diff",
    "--no-textconv",
    "--",
];
const NARROW_UNTRACKED_ARGS = [
    "--no-optional-locks",
    "ls-files",
    "--others",
    "--exclude-standard",
    "--directory",
    "--no-empty-directory",
    "-z",
];

/** `git diff --name-status` for tracked paths, and `git ls-files --others` when `need` is "all". Git's order. */
export function readNarrowStatus(
    root: string,
    options: { need: "deletions" | "all"; timeoutMs?: number }
): GitRead<StatusEntry[]> {
    const tracked = runGitSync(root, NARROW_TRACKED_ARGS, options.timeoutMs);

    if (!tracked.ok) {
        return tracked;
    }

    const entries: StatusEntry[] = [];
    const tokens = tracked.value.split("\0");

    for (let i = 0; i + 1 < tokens.length; i += 2) {
        const letter = tokens[i];
        const path = tokens[i + 1];

        if (letter !== "M" && letter !== "D") {
            // A letter the narrow read cannot map (a type change, an unmerged path) is a failure, never a guess.
            return { ok: false, reason: "exit", detail: `unsupported-status: ${letter} ${path}`, cost: tracked.cost };
        }

        if (options.need === "deletions" && letter !== "D") {
            continue;
        }

        entries.push({ kind: "changed", path, index: ".", worktree: letter, submodule: "N..." });
    }

    if (options.need === "deletions") {
        return { ok: true, value: entries, cost: tracked.cost };
    }

    const untracked = runGitSync(root, NARROW_UNTRACKED_ARGS, options.timeoutMs);
    const cost = addCost(tracked.cost, untracked.cost);

    if (!untracked.ok) {
        return { ...untracked, cost };
    }

    for (const path of untracked.value.split("\0")) {
        if (path) {
            entries.push({ kind: "untracked", path, index: "?", worktree: "?" });
        }
    }

    return { ok: true, value: entries, cost };
}

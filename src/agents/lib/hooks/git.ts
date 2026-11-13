import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import {
    parseStatusPorcelainV2Z,
    STATUS_PORCELAIN_ARGS,
    type StatusEntry,
    type StatusSummary,
} from "@genesiscz/utils/git/porcelain";
import { hookDiag } from "./log";

/** Big enough for a `git diff HEAD` of a large file; a breach is reported, never swallowed. */
const MAX_BUFFER = 8_000_000;

/**
 * How long one git process of the hook may run, and the untracked listings of one call together. The harness kills
 * the whole hook at its own timeout (15 s, `install.ts`), so a git that stalls on a slow or unreachable filesystem
 * must be stopped first; its answer then counts as a failure, never as the partial output it wrote.
 */
export const GIT_TIMEOUT_MS = 5_000;

function errorCode(run: SpawnSyncReturns<string>): string | undefined {
    return (run.error as NodeJS.ErrnoException | undefined)?.code;
}

/**
 * One git runner for the whole hook, so a failure is reported in one place.
 *
 * git's own "found differences" exit code is 1, which is not an error, so 0 and 1 both return
 * output. ANYTHING ELSE is a real failure — a missing binary, a broken repository, a
 * `maxBuffer` overflow, a run past `GIT_TIMEOUT_MS` — and returning "" for those silently turns
 * it into "nothing changed", which the post phase then reports as the reassuring
 * `no change since this command began`.
 *
 * `quiet` is for the ONE call whose failure is expected: asking a directory that is not a
 * repository for its toplevel exits 128 every time, and logging that would bury the failures
 * that matter. It hides an exit code only: a git that never finished is always reported.
 */
export function gitOut(root: string, args: string[], options: { quiet?: boolean } = {}): string {
    const run = spawnSync("git", ["-C", root, ...args], {
        encoding: "utf8",
        maxBuffer: MAX_BUFFER,
        timeout: GIT_TIMEOUT_MS,
    });

    if (run.error || (run.status !== 0 && run.status !== 1 && !options.quiet)) {
        const timedOut = errorCode(run) === "ETIMEDOUT";
        hookDiag(
            timedOut
                ? `git did not finish within ${GIT_TIMEOUT_MS} ms, so this root reads as unchanged`
                : "git failed, so this root reads as unchanged",
            {
                root,
                args,
                status: run.status,
                signal: run.signal,
                error: errorCode(run),
                stderr: typeof run.stderr === "string" ? run.stderr.slice(0, 400) : undefined,
            }
        );

        return "";
    }

    return typeof run.stdout === "string" ? run.stdout : "";
}

/**
 * The repository's canonical status reader, not a second hand-rolled parser: porcelain v2,
 * NUL-terminated, so a path with a space or a non-ASCII byte arrives unquoted.
 *
 * `--no-renames` is deliberate. Rename detection would make the before-state lookup
 * ambiguous, because the capture is keyed by the path as it was when the command began.
 *
 * `core.preloadIndex=false` applies to this one process and is never written anywhere. It only
 * chooses how git stats the index entries: one thread instead of up to 20. The answer is the same
 * byte for byte, and the threads cost three times the CPU. Measured 2026-10-12 on a 9,278-file
 * clone at a load average of about 30, median of 9 interleaved runs: 151 to 163 ms of CPU
 * (45 ms wall) with the threads, 49 ms (50 ms wall) without. The threads contend in the kernel:
 * a single-threaded `git ls-files --deleted` stats the same files in 19 ms.
 */
export function statusOf(root: string): StatusSummary {
    return parseStatusPorcelainV2Z(
        gitOut(root, ["-c", "core.preloadIndex=false", ...STATUS_PORCELAIN_ARGS, "--no-renames"])
    );
}

export function statusEntries(root: string): StatusEntry[] {
    return statusOf(root).entries;
}

/** A 40-hex object id, or `null`. `git rev-parse` echoes the literal `HEAD` on an empty repo. */
export function objectId(value: string | undefined): string | null {
    return value !== undefined && /^[0-9a-f]{40}$/.test(value) ? value : null;
}

/**
 * What HEAD's reflog says moved it through history instead of adding a commit of the caller's own:
 * a rebase, pull, merge, checkout, switch, reset, cherry-pick or am. `commit`, `commit (amend)` and
 * `revert` are the command's own work and are not listed here.
 */
const HISTORY_MOVE = /^(checkout|rebase|pull|merge|reset|cherry-pick|am|clone)\b/;
/** Entries are read newest first and stop at the first one older than the command. */
const REFLOG_ENTRIES = 200;

export interface HistoryMove {
    /** The command word, for the note: `rebase`, `checkout`, `pull`... */
    verb: string;
    /** Where HEAD stood right after that move; commits past it are the command's own. */
    head: string;
}

/**
 * The NEWEST history move HEAD made since `sinceMs`, or null when every move was a plain commit
 * (or the reflog says nothing, which then reads as the old behaviour). Only called when HEAD
 * actually moved during the command, so the ordinary call pays nothing for it.
 *
 * The walk also stops at the entry where HEAD stood at `startedOn`: that entry and everything
 * older happened before the command. The clock alone cannot say so, because the reflog and the
 * command stamp both have whole-second resolution, and a checkout made in the second before the
 * command began would read as the command's own.
 */
export function lastHistoryMove(root: string, sinceMs: number, startedOn: string): HistoryMove | null {
    const sinceSeconds = Math.floor(sinceMs / 1000);
    const lines = gitOut(
        root,
        ["reflog", "show", "--date=unix", "--format=%H%x09%gd%x09%gs", "-n", String(REFLOG_ENTRIES), "HEAD"],
        { quiet: true }
    ).split("\n");

    for (const line of lines) {
        const [head, selector, subject] = line.split("\t");
        const at = Number(/\{(\d+)\}/.exec(selector ?? "")?.[1]);

        if (!objectId(head) || !subject || !Number.isFinite(at)) {
            continue;
        }

        if (at < sinceSeconds || head === startedOn) {
            return null;
        }

        const verb = HISTORY_MOVE.exec(subject)?.[1];

        if (verb && head) {
            return { verb, head };
        }
    }

    return null;
}

/**
 * Paths a commit range touched. Only called when HEAD actually moved during the command, so
 * the ordinary call pays nothing for it.
 */
export function committedPaths(root: string, from: string, to: string): string[] {
    return gitOut(root, ["diff", "--name-only", "-z", `${from}..${to}`])
        .split("\0")
        .filter((name) => name.length > 0);
}

/** `true` for a path git reports as deleted on either side. */
export function isDeleted(entry: StatusEntry): boolean {
    return entry.index === "D" || entry.worktree === "D";
}

/** A wholly-untracked DIRECTORY, which git collapses to one entry ending in `/`. */
export function isUntrackedDirectory(entry: StatusEntry): boolean {
    return entry.kind === "untracked" && entry.path.endsWith("/");
}

/** Room for one listed name: a path component chain well past macOS's 1024-byte PATH_MAX. */
const BYTES_PER_LISTED_NAME = 4096;

/**
 * The files inside a wholly-untracked directory, relative to `root`, at most `limit` of them,
 * or `null` when git could not list them.
 *
 * `--exclude-standard` keeps ignored files out, which a bare directory entry handed to `tar`
 * or `stat` does not: it archives a build output or dataset whole.
 *
 * 🛑 The limit bounds the WORK, not only the result. The buffer is sized to `limit` names, and
 * a listing that outgrows it stops git there (ENOBUFS, measured on bun: the child is signalled
 * and the names read so far are kept). Reading the whole listing and slicing afterwards made a
 * huge untracked tree cost a full enumeration per hook, and overflowing the shared 8 MB buffer
 * returned "" — an empty directory — so the capture recorded it as neither taken nor left out.
 *
 * Time is bounded too: a listing that runs past `GIT_TIMEOUT_MS` (a slow or unreachable
 * filesystem) is stopped and counts as one git could not make.
 */
export function untrackedFilesIn(root: string, dir: string, limit: number): string[] | null {
    return untrackedWithin({ root, dir, limit, timeoutMs: GIT_TIMEOUT_MS });
}

/** One `git ls-files --others` over `dirs`, with a buffer of `cap` names' worth and a deadline. */
function listOthers({
    root,
    dirs,
    cap,
    timeoutMs,
}: {
    root: string;
    dirs: readonly string[];
    cap: number;
    timeoutMs: number;
}): SpawnSyncReturns<string> {
    return spawnSync("git", ["-C", root, "ls-files", "--others", "--exclude-standard", "-z", "--", ...dirs], {
        encoding: "utf8",
        maxBuffer: Math.min(MAX_BUFFER, Math.max(65_536, (cap + 1) * BYTES_PER_LISTED_NAME)),
        timeout: timeoutMs,
    });
}

function untrackedWithin({
    root,
    dir,
    limit,
    timeoutMs,
}: {
    root: string;
    dir: string;
    limit: number;
    timeoutMs: number;
}): string[] | null {
    const cap = Math.max(0, limit);
    const run = listOthers({ root, dirs: [dir], cap, timeoutMs });
    const overflowed = errorCode(run) === "ENOBUFS";

    if (!overflowed && run.status !== 0) {
        hookDiag(
            errorCode(run) === "ETIMEDOUT"
                ? `git did not list an untracked directory within ${timeoutMs} ms`
                : "git could not list an untracked directory",
            {
                root,
                dir,
                status: run.status,
                signal: run.signal,
                error: errorCode(run),
                stderr: typeof run.stderr === "string" ? run.stderr.slice(0, 400) : undefined,
            }
        );

        return null;
    }

    const names = (typeof run.stdout === "string" ? run.stdout : "").split("\0");

    if (overflowed) {
        // The last name was cut mid-write; only NUL-terminated ones are whole.
        names.pop();
    }

    return names.filter((name) => name.length > 0).slice(0, cap);
}

/** A directory git would read as a pattern or as pathspec magic, not as a plain prefix: listed by itself. */
const PATHSPEC_SPECIAL = /[*?[\\]|^:/;
/** Directories per listing: the argv stays far under the kernel's limit. */
const DIRS_PER_LISTING = 64;

/**
 * `untrackedFilesIn` for several wholly-untracked directories of one root, with one git process for
 * all of them instead of one each. A checkout with 47 untracked directories started 47 `git ls-files`
 * in the post phase of every Bash call, and 47 more in the pre phase of a call that edits (measured
 * 2026-11-10 in a notes vault: 98 git processes for one call, about 7.5 ms of CPU each).
 *
 * The answer per directory is the one `untrackedFilesIn` gives. The whole batch gets the buffer ONE
 * directory may fill, so the work stays bounded; a batch that outgrows it, or that git refuses, is
 * listed again one directory at a time, with each directory's own bound and its own diagnosis.
 *
 * Every listing of one call shares one deadline (`budgetMs`, default `GIT_TIMEOUT_MS`). A batch that
 * runs out of time is a failed listing for each of its directories and is NOT listed again: the tree
 * is slow, not big, and one listing per directory would wait the same way. A directory left when the
 * deadline has passed gets no listing at all (null).
 */
export function untrackedFilesInEach(
    root: string,
    dirs: readonly string[],
    limit: number,
    options: { budgetMs?: number } = {}
): Map<string, string[] | null> {
    const cap = Math.max(0, limit);
    const budgetMs = options.budgetMs ?? GIT_TIMEOUT_MS;
    const deadline = Date.now() + budgetMs;
    const listed = new Map<string, string[] | null>();
    const together = [...new Set(dirs)].filter((dir) => dir.endsWith("/") && !PATHSPEC_SPECIAL.test(dir));

    for (let start = 0; start < together.length; start += DIRS_PER_LISTING) {
        const batch = together.slice(start, start + DIRS_PER_LISTING);
        const timeoutMs = deadline - Date.now();

        if (timeoutMs <= 0) {
            break;
        }

        if (batch.length < 2) {
            continue;
        }

        const run = listOthers({ root, dirs: batch, cap, timeoutMs });

        if (errorCode(run) === "ETIMEDOUT") {
            hookDiag(`git did not list ${batch.length} untracked directories within ${timeoutMs} ms`, {
                root,
                dirs: batch,
            });

            for (const dir of batch) {
                listed.set(dir, null);
            }

            continue;
        }

        if (run.error || run.status !== 0 || typeof run.stdout !== "string") {
            continue;
        }

        for (const dir of batch) {
            listed.set(dir, []);
        }

        for (const name of run.stdout.split("\0")) {
            // A wholly-untracked directory never holds another one, so at most one prefix fits.
            const dir = name.length > 0 ? batch.find((prefix) => name.startsWith(prefix)) : undefined;
            const names = dir === undefined ? undefined : listed.get(dir);

            if (names && names.length < cap) {
                names.push(name);
            }
        }
    }

    const unlisted: string[] = [];

    for (const dir of dirs) {
        if (listed.has(dir)) {
            continue;
        }

        const timeoutMs = deadline - Date.now();

        if (timeoutMs <= 0) {
            listed.set(dir, null);
            unlisted.push(dir);
            continue;
        }

        listed.set(dir, untrackedWithin({ root, dir, limit, timeoutMs }));
    }

    if (unlisted.length > 0) {
        hookDiag(`no time was left to list ${unlisted.length} untracked directories`, { root, budgetMs, unlisted });
    }

    return listed;
}

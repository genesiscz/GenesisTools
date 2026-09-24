import { spawnSync } from "node:child_process";
import { parseStatusPorcelainV2Z, STATUS_PORCELAIN_ARGS, type StatusEntry } from "@genesiscz/utils/git/porcelain";
import { hookDiag } from "./log";

/** Big enough for a `git diff HEAD` of a large file; a breach is reported, never swallowed. */
const MAX_BUFFER = 8_000_000;

/**
 * One git runner for the whole hook, so a failure is reported in one place.
 *
 * git's own "found differences" exit code is 1, which is not an error, so 0 and 1 both return
 * output. ANYTHING ELSE is a real failure — a missing binary, a broken repository, a
 * `maxBuffer` overflow — and returning "" for those silently turns it into "nothing changed",
 * which the post phase then reports as the reassuring `no change since this command began`.
 *
 * `quiet` is for the ONE call whose failure is expected: asking a directory that is not a
 * repository for its toplevel exits 128 every time, and logging that would bury the failures
 * that matter.
 */
export function gitOut(root: string, args: string[], options: { quiet?: boolean } = {}): string {
    const run = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: MAX_BUFFER });

    if (run.status !== 0 && run.status !== 1 && !options.quiet) {
        hookDiag("git failed, so this root reads as unchanged", {
            root,
            args,
            status: run.status,
            signal: run.signal,
            stderr: typeof run.stderr === "string" ? run.stderr.slice(0, 400) : undefined,
        });

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
 */
export function statusEntries(root: string): StatusEntry[] {
    return parseStatusPorcelainV2Z(gitOut(root, [...STATUS_PORCELAIN_ARGS, "--no-renames"])).entries;
}

/** `true` for a path git reports as deleted on either side. */
export function isDeleted(entry: StatusEntry): boolean {
    return entry.index === "D" || entry.worktree === "D";
}

/** A wholly-untracked DIRECTORY, which git collapses to one entry ending in `/`. */
export function isUntrackedDirectory(entry: StatusEntry): boolean {
    return entry.kind === "untracked" && entry.path.endsWith("/");
}

/**
 * The files inside a wholly-untracked directory, relative to `root`, at most `limit` of them.
 * `--exclude-standard` keeps ignored files out, which a bare directory entry handed to `tar`
 * or `stat` does not: it archives a build output or dataset whole.
 */
export function untrackedFilesIn(root: string, dir: string, limit: number): string[] {
    return gitOut(root, ["ls-files", "--others", "--exclude-standard", "-z", "--", dir])
        .split("\0")
        .filter((name) => name.length > 0)
        .slice(0, Math.max(0, limit));
}

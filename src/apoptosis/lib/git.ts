import { resolve } from "node:path";
import { logger } from "@genesiscz/utils/logger";

const DAY_MS = 86_400_000;

/**
 * The absolute start of a churn window, as an ISO-8601 date git accepts.
 *
 * `--since=<n> days ago` makes git resolve the window against the SYSTEM clock,
 * while every other date in a scan comes from the injected `now`. The two agree
 * only while the calendar cooperates: a fixture pinning `now` to 2026-06-02 with
 * a commit at 2026-05-30 and a 90-day window passed for exactly 90 days, then
 * began failing on 2026-08-28 with no code change. Deriving the cutoff from
 * `now` makes the window a function of its inputs alone.
 */
export function churnCutoff(days: number, now: number): string {
    return new Date(now - days * DAY_MS).toISOString();
}

export interface ChurnQuery {
    churnDays: number;
    repoRoot: string;
    now: number;
}

/**
 * Count commits in the churn window that touched every file under `repoRoot`, via
 * a single `git log --name-only` invocation. Returns a map of absolute path to
 * commit count; empty outside a repo or on any git failure.
 */
export async function getChurnCounts({ churnDays, repoRoot, now }: ChurnQuery): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    try {
        const proc = Bun.spawn({
            cmd: [
                "git",
                "-c",
                "core.quotePath=false",
                "log",
                `--since=${churnCutoff(churnDays, now)}`,
                "--name-only",
                "--format=",
                "--",
            ],
            cwd: repoRoot,
            stdout: "pipe",
            stderr: "pipe",
        });
        const stdout = await new Response(proc.stdout).text();
        const exitCode = await proc.exited;
        if (exitCode !== 0) {
            logger.debug(`apoptosis: git log exited ${exitCode}`);
            return counts;
        }

        for (const line of stdout.split("\n")) {
            const trimmed = line.trim();
            if (trimmed.length > 0) {
                const absPath = resolve(repoRoot, trimmed);
                counts.set(absPath, (counts.get(absPath) ?? 0) + 1);
            }
        }
    } catch (error) {
        logger.debug(`apoptosis: bulk churn lookup failed: ${error}`);
    }

    return counts;
}

/**
 * Count commits in the churn window that touched `file`, via `git log`. Returns 0
 * outside a repo, for untracked files, or on any git failure.
 */
export async function churnCountForFile({
    file,
    churnDays,
    repoRoot,
    now,
}: ChurnQuery & { file: string }): Promise<number> {
    try {
        const proc = Bun.spawn({
            cmd: ["git", "log", `--since=${churnCutoff(churnDays, now)}`, "--format=%H", "--", file],
            cwd: repoRoot,
            stdout: "pipe",
            stderr: "pipe",
        });
        const stdout = await new Response(proc.stdout).text();
        const exitCode = await proc.exited;
        if (exitCode !== 0) {
            logger.debug(`apoptosis: git log exited ${exitCode} for ${file}`);
            return 0;
        }

        return stdout.split("\n").filter((line) => line.trim().length > 0).length;
    } catch (error) {
        logger.debug(`apoptosis: churn lookup failed for ${file}: ${error}`);
        return 0;
    }
}

/** Resolve the git repo root for `dir`, or null if not in a repo. */
export async function findRepoRoot(dir: string): Promise<string | null> {
    try {
        const proc = Bun.spawn({
            cmd: ["git", "rev-parse", "--show-toplevel"],
            cwd: dir,
            stdout: "pipe",
            stderr: "pipe",
        });
        const stdout = await new Response(proc.stdout).text();
        const exitCode = await proc.exited;
        if (exitCode !== 0) {
            return null;
        }

        return stdout.trim() || null;
    } catch (error) {
        logger.debug(`apoptosis: repo-root lookup failed for ${dir}: ${error}`);
        return null;
    }
}

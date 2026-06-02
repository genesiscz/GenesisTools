import { logger } from "@app/logger";

/**
 * Count commits in the last `days` that touched `file`, via `git log`. Returns 0
 * outside a repo, for untracked files, or on any git failure.
 */
export async function churnCountForFile(file: string, days: number, repoRoot: string): Promise<number> {
    try {
        const proc = Bun.spawn({
            cmd: ["git", "log", `--since=${days} days ago`, "--format=%H", "--", file],
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

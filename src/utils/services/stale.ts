import { statSync } from "node:fs";
import { join } from "node:path";
import { parseStatusPorcelainV2Z } from "@genesiscz/utils/git/porcelain";
import { logger } from "@genesiscz/utils/logger";
import { captureSync } from "@genesiscz/utils/process/ps";

/** The checkout this code runs from; the services it lists run from the same tree. */
export const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

/** `src/<tool>/` from the paths in a command line (`.../GenesisTools/src/youtube/ui/vite.config.ts`), plus `src/utils/`. */
export function sourceRoots(command: string): string[] {
    const tools = [...command.matchAll(/\/GenesisTools\/src\/([a-z0-9][a-z0-9-]*)\//g)].map((match) => match[1]);
    return [...new Set([...tools.map((tool) => `src/${tool}/`), "src/utils/"])];
}

export interface StaleDeps {
    /** Paths changed by commits after `sinceMs`, under `roots`. */
    committedSince(sinceMs: number, roots: string[]): string[];
    /** Uncommitted paths under `roots`. */
    dirty(roots: string[]): string[];
    mtimeMs(path: string): number | null;
}

/**
 * Source files a process started at `startedAt` does not run: changed in a commit since then, or
 * edited and not committed with a newer mtime, or deleted and not committed. Empty means current. A rebased commit counts as new,
 * which only ever reports a service as stale when it is not.
 */
export function staleFiles({
    startedAt,
    command,
    deps = gitDeps(),
}: {
    startedAt: number;
    command: string;
    deps?: StaleDeps;
}): string[] {
    const roots = sourceRoots(command);
    const committed = deps.committedSince(startedAt, roots);
    // A dirty path with no mtime is an uncommitted deletion: the process may still run the old file.
    const edited = deps.dirty(roots).filter((path) => (deps.mtimeMs(path) ?? Number.POSITIVE_INFINITY) > startedAt);
    return [...new Set([...committed, ...edited])].sort();
}

export function gitDeps(repo = REPO_ROOT): StaleDeps {
    const git = (args: string[]) => {
        const run = captureSync("git", ["-C", repo, ...args]);

        if (run.status !== 0) {
            logger.debug({ args, stderr: run.stderr }, "services: git failed");
        }

        return run.stdout;
    };
    return {
        committedSince: (sinceMs, roots) =>
            git(["log", `--since=@${Math.floor(sinceMs / 1000)}`, "--name-only", "--format=", "--", ...roots])
                .split("\n")
                .filter(Boolean),
        // The shared typed reader: a rename's source path is its own field, never mistaken for a status row.
        dirty: (roots) =>
            parseStatusPorcelainV2Z(git(["status", "--porcelain=v2", "-z", "--untracked-files=all", "--", ...roots]))
                .entries.filter((entry) => entry.kind !== "ignored")
                .map((entry) => entry.path),
        mtimeMs: (path) => {
            try {
                return statSync(join(repo, path)).mtimeMs;
            } catch (error) {
                logger.debug({ error, path }, "services: a dirty path is gone");
                return null;
            }
        },
    };
}

export type StaleRow<T> = T & { stale: string[] };

/** Each row with the source files it does not run; a row with no start time counts as current. */
export function withStaleness<T extends { startedAt: number | null; command: string }>(
    rows: T[],
    deps: StaleDeps = gitDeps()
): StaleRow<T>[] {
    return rows.map((row) => ({
        ...row,
        stale: row.startedAt === null ? [] : staleFiles({ startedAt: row.startedAt, command: row.command, deps }),
    }));
}

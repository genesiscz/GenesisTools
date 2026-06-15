import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import { Storage } from "@app/utils/storage/storage";
import { distillEntry } from "./entry";
import { collectBugFixCommits } from "./git";
import { INDEX_VERSION, type RegretIndex } from "./types";

/** Default ceiling on how many bug-fix commits we index per repo. */
export const DEFAULT_MAX_COMMITS = 2000;

/** Default per-commit diff byte budget before token distillation. */
export const DEFAULT_MAX_DIFF_BYTES = 20_000;

/**
 * One index file per repo, named by a stable hash of the repo's absolute path.
 * A single `~/.genesis-tools/regret-grep/indexes/` dir holds them all, so the
 * per-PC layout stays flat (one tool dir, many repo files) rather than scattering
 * caches per scan-root.
 */
function indexFilePath(repo: string): string {
    const storage = new Storage("regret-grep");
    const dir = join(storage.getBaseDir(), "indexes");
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }

    const key = createHash("sha1").update(repo).digest("hex").slice(0, 16);
    return join(dir, `${key}.json`);
}

/**
 * Build (or rebuild) the bug-fix index for {@link repo} and persist it.
 *
 * `now` is injected so the persisted `builtAt` is deterministic in tests. Pure
 * distillation lives in {@link distillEntry}; this function only orchestrates
 * git collection, distillation and the disk write.
 */
export async function buildIndex(opts: {
    repo: string;
    since?: string;
    maxCommits?: number;
    maxDiffBytesPerCommit?: number;
    now?: Date;
}): Promise<RegretIndex> {
    const { repo, since } = opts;
    const maxCommits = opts.maxCommits ?? DEFAULT_MAX_COMMITS;
    const maxDiffBytesPerCommit = opts.maxDiffBytesPerCommit ?? DEFAULT_MAX_DIFF_BYTES;
    const now = opts.now ?? new Date();

    const commits = await collectBugFixCommits({ cwd: repo, since, maxCommits, maxDiffBytesPerCommit });
    const entries = commits.map(distillEntry);

    const index: RegretIndex = {
        version: INDEX_VERSION,
        repo,
        builtAt: now.toISOString(),
        entries,
    };

    const filePath = indexFilePath(repo);
    await Bun.write(filePath, SafeJSON.stringify(index, null, 2));
    logger.debug(`wrote regret-grep index for ${repo} (${entries.length} entries) to ${filePath}`);

    return index;
}

/**
 * Load the persisted index for {@link repo}, or null when none has been built
 * (or the on-disk schema version no longer matches).
 */
export async function loadIndex(repo: string): Promise<RegretIndex | null> {
    const filePath = indexFilePath(repo);
    if (!existsSync(filePath)) {
        return null;
    }

    try {
        const raw = await Bun.file(filePath).text();
        const parsed = SafeJSON.parse(raw) as RegretIndex;
        if (parsed.version !== INDEX_VERSION) {
            logger.debug(`regret-grep index at ${filePath} is version ${parsed.version}, expected ${INDEX_VERSION}`);
            return null;
        }

        return parsed;
    } catch (error) {
        logger.warn(`failed to read regret-grep index at ${filePath}: ${error}`);
        return null;
    }
}

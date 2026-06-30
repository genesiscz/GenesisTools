import { createHash } from "node:crypto";
import { logger } from "@app/logger";

const { log } = logger.scoped("stash:tree-hash");

/** Default similarity threshold; tunable via hidden `--similarity-threshold` flag (caller passes through). */
export const DEFAULT_TREE_HASH_THRESHOLD = 0.7;
/** How many file paths to sample from `git ls-files`. Top-100 in lexicographic order keeps things deterministic. */
const SAMPLE_LIMIT = 100;

/**
 * Compute a stable hash of the top-100 (lexicographically sorted) file paths in a repo.
 * Cacheable identity used to compare two projects without re-running git ls-files each time.
 */
export async function computeTreeHash(repoDir: string): Promise<string> {
    const paths = await listTopFilePaths(repoDir);
    const h = createHash("sha256");

    for (const p of paths) {
        h.update(p);
        h.update("\n");
    }

    return h.digest("hex");
}

/**
 * Compute Jaccard similarity between two repos' top-100 file path sets.
 * Returns a number in [0, 1]. Higher = more similar. ≥0.7 is a reasonable "same project" threshold.
 *
 * If you compare one base repo against many candidates, precompute the base set with
 * `listTopFilePaths(baseRepo)` once and pass it via `baseSet` to skip the per-call git ls-files
 * on the shared side.
 */
export async function computeTreeHashSimilarity(repoA: string, repoB: string, baseSet?: Set<string>): Promise<number> {
    const a = baseSet ?? new Set(await listTopFilePaths(repoA));
    const b = new Set(await listTopFilePaths(repoB));

    if (a.size === 0 && b.size === 0) {
        return 0;
    }

    let intersection = 0;

    for (const p of a) {
        if (b.has(p)) {
            intersection++;
        }
    }

    const union = a.size + b.size - intersection;
    const sim = union === 0 ? 0 : intersection / union;
    log.debug({ repoA, repoB, aSize: a.size, bSize: b.size, intersection, union, sim }, "tree-hash similarity");
    return sim;
}

export async function listTopFilePaths(repoDir: string): Promise<string[]> {
    try {
        const proc = Bun.spawn(["git", "-C", repoDir, "ls-files"], { stdout: "pipe", stderr: "pipe" });
        const [stdout, exit] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

        if (exit !== 0) {
            log.debug({ repoDir, exit }, "git ls-files failed");
            return [];
        }

        return stdout.split("\n").filter(Boolean).sort().slice(0, SAMPLE_LIMIT);
    } catch (err) {
        log.debug({ err, repoDir }, "git ls-files threw");
        return [];
    }
}

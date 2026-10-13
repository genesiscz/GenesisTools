import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import { chunkKey, type FilePair, type Pairing, pairFiles } from "./pair.ts";
import { survivorTokens } from "./token-rank.ts";

const { log } = logger.scoped("ts:sourcemaps:pair");
const prof = profiler.scope("sourcemaps");

/** Two files are the same chunk only when at least this share of their surviving tokens is common (Jaccard). */
const MIN_SHARED = 0.5;

export interface ContentPairing extends Pairing {
    /** Pairs made by content because the name alone was ambiguous (counted in `pairs` too). */
    byContent: number;
}

/**
 * `pairFiles`, then the files it left unpaired because many share one name once the hash is gone: esbuild and
 * Angular emit `chunk-K3J2Q1ZA.js` for every shared chunk. Within one such name, each deployed file is paired
 * with the local file that shares the most surviving tokens (strings and property names, which minifiers keep),
 * best pairs first, and only when they share at least half of them. A content pair's key is the deployed path,
 * so it stays unique.
 */
export async function pairFilesByContent(options: {
    deployedDir: string;
    deployed: string[];
    localDir: string;
    local: string[];
}): Promise<ContentPairing> {
    const stop = prof.start("pair.content");
    try {
        const named = pairFiles(options.deployed, options.local);
        const deployedLeft = groupByKey(named.deployedOnly);
        const localLeft = groupByKey(named.localOnly);
        const pairs: FilePair[] = [...named.pairs];
        const pairedDeployed = new Set<string>();
        const pairedLocal = new Set<string>();
        for (const [key, deployedPaths] of deployedLeft) {
            const localPaths = localLeft.get(key);
            if (!localPaths) {
                continue;
            }

            const [deployedTokens, localTokens] = await Promise.all([
                tokenSets(options.deployedDir, deployedPaths),
                tokenSets(options.localDir, localPaths),
            ]);
            const candidates: Array<{ deployed: string; local: string; shared: number }> = [];
            for (const [deployed, a] of deployedTokens) {
                for (const [local, b] of localTokens) {
                    const shared = jaccard(a, b);
                    if (shared >= MIN_SHARED) {
                        candidates.push({ deployed, local, shared });
                    }
                }
            }

            candidates.sort((x, y) => y.shared - x.shared);
            for (const candidate of candidates) {
                if (pairedDeployed.has(candidate.deployed) || pairedLocal.has(candidate.local)) {
                    continue;
                }

                pairedDeployed.add(candidate.deployed);
                pairedLocal.add(candidate.local);
                pairs.push({ key: candidate.deployed, deployed: candidate.deployed, local: candidate.local });
            }
        }

        const byContent = pairs.length - named.pairs.length;
        if (byContent > 0) {
            log.debug({ byName: named.pairs.length, byContent }, "files paired by content");
        }

        return {
            pairs,
            deployedOnly: named.deployedOnly.filter((path) => !pairedDeployed.has(path)),
            localOnly: named.localOnly.filter((path) => !pairedLocal.has(path)),
            byContent,
        };
    } finally {
        stop();
    }
}

function groupByKey(paths: string[]): Map<string, string[]> {
    const groups = new Map<string, string[]>();
    for (const path of paths) {
        const key = chunkKey(path);
        groups.set(key, [...(groups.get(key) ?? []), path]);
    }

    return groups;
}

async function tokenSets(dir: string, paths: string[]): Promise<Map<string, Set<string>>> {
    const sets = new Map<string, Set<string>>();
    for (const path of paths) {
        const code = await readFile(join(dir, path), "utf8");
        try {
            sets.set(path, new Set(survivorTokens(code, path).keys()));
        } catch (error) {
            log.debug({ path, error }, "chunk does not parse; it is not paired by content");
        }
    }

    return sets;
}

function jaccard(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 || b.size === 0) {
        return 0;
    }

    const [small, large] = a.size <= b.size ? [a, b] : [b, a];
    let common = 0;
    for (const token of small) {
        if (large.has(token)) {
            common++;
        }
    }

    return common / (a.size + b.size - common);
}

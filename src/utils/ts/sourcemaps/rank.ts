import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { profiler } from "@genesiscz/utils/profile";
import { debugIdOf } from "./debug-id.ts";
import type { DeployedFile } from "./deployed.ts";
import { chunkSimilarity, type Similarity } from "./pair.ts";
import { pairFilesByContent } from "./pair-content.ts";
import type { LocalBuild } from "./resolvers/local-build.ts";

const prof = profiler.scope("sourcemaps");

export interface ChunkScore {
    key: string;
    deployed: string;
    local: string;
    similarity: Similarity;
    /**
     * Both files carry a debug id and they are equal: with the same monitoring plugin on both sides, the
     * chunk's code before minification is identical. Null when either side carries none.
     */
    debugIdMatch: boolean | null;
}

export interface BuildScore {
    label: string;
    /** Probe hit rate over every paired chunk (0..1), weighted by chunk size. */
    rate: number;
    probes: number;
    hits: number;
    /** Deployed files the build has no counterpart for. */
    deployedOnly: string[];
    /** Build files the deployment has no counterpart for. */
    localOnly: string[];
    chunks: ChunkScore[];
    /** Paired chunks whose debug ids could be compared, and how many of them were equal. */
    debugIds: { compared: number; equal: number };
}

/** Scores how much of the deployed code each build contains, chunk by chunk. */
export async function scoreBuild(options: {
    deployed: { dir: string; files: DeployedFile[] };
    build: LocalBuild;
    /** Only score these chunk keys (for a quick re-rank of the chunks that differ). */
    onlyKeys?: Set<string>;
}): Promise<BuildScore> {
    const stopProfile = prof.start("rank.score");
    try {
        const deployedJs = options.deployed.files.filter((file) => /\.m?js$/.test(file.path)).map((file) => file.path);
        const pairing = await pairFilesByContent({
            deployedDir: options.deployed.dir,
            deployed: deployedJs,
            localDir: options.build.dir,
            local: options.build.files,
        });
        const chunks: ChunkScore[] = [];
        let probes = 0;
        let hits = 0;
        for (const pair of pairing.pairs) {
            if (options.onlyKeys && !options.onlyKeys.has(pair.key)) {
                continue;
            }

            const [deployedCode, localCode] = await Promise.all([
                readFile(join(options.deployed.dir, pair.deployed), "utf8"),
                readFile(join(options.build.dir, pair.local), "utf8"),
            ]);
            const similarity = chunkSimilarity(deployedCode, localCode);
            probes += similarity.probes;
            hits += similarity.hits;
            const deployedId = debugIdOf(deployedCode);
            const localId = debugIdOf(localCode);
            chunks.push({ ...pair, similarity, debugIdMatch: deployedId && localId ? deployedId === localId : null });
        }

        return {
            label: options.build.label,
            rate: probes === 0 ? 0 : hits / probes,
            probes,
            hits,
            deployedOnly: pairing.deployedOnly,
            localOnly: pairing.localOnly,
            chunks,
            debugIds: {
                compared: chunks.filter((chunk) => chunk.debugIdMatch !== null).length,
                equal: chunks.filter((chunk) => chunk.debugIdMatch === true).length,
            },
        };
    } finally {
        stopProfile();
    }
}

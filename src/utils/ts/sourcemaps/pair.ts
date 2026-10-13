import { normalizeIdentifiers } from "./align.ts";

/**
 * A file's identity across builds: its path with the content hash removed.
 * `static/js/710.f9e49e56.chunk.js` and `static/js/710.88ba0dad.chunk.js` share `static/js/710.chunk.js`;
 * Vite's `assets/index-B3x9kQ1a.js` becomes `assets/index.js` (hashes of 8 to 20 hex or base64url characters).
 */
const HEX_OR_ALNUM_HASH = /[.-](?=[0-9a-zA-Z_]*\d)[0-9a-zA-Z_]{8,20}(?=\.(?:chunk\.)?m?js$|\.css$)/;
// Rollup and Vite: `-` plus 8 base64url characters, which may include `-` and `_`; a real hash has an upper-case
// letter, a digit or one of those two (8 lower-case letters is a word such as `overview`).
const BASE64URL_HASH = /-(?=[A-Za-z0-9_-]{0,7}[A-Z0-9_-])[A-Za-z0-9_-]{8}(?=\.m?js$|\.css$)/;

export function chunkKey(path: string): string {
    const stripped = path.replace(HEX_OR_ALNUM_HASH, "");
    return stripped !== path ? stripped : path.replace(BASE64URL_HASH, "");
}

export interface FilePair {
    key: string;
    deployed: string;
    local: string;
}

export interface Pairing {
    pairs: FilePair[];
    deployedOnly: string[];
    localOnly: string[];
}

/**
 * Pairs deployed and local files by `chunkKey`. A key that is not unique on one side is left unpaired, and its
 * files are reported in `deployedOnly` / `localOnly` like any other unpaired file.
 */
export function pairFiles(deployed: string[], local: string[]): Pairing {
    const index = (paths: string[]): Map<string, string[]> => {
        const byKey = new Map<string, string[]>();
        for (const path of paths) {
            const key = chunkKey(path);
            byKey.set(key, [...(byKey.get(key) ?? []), path]);
        }

        return byKey;
    };
    const deployedByKey = index(deployed);
    const localByKey = index(local);
    const pairs: FilePair[] = [];
    for (const [key, paths] of deployedByKey) {
        const matches = localByKey.get(key);
        if (paths.length === 1 && matches?.length === 1) {
            pairs.push({ key, deployed: paths[0] as string, local: matches[0] as string });
        }
    }

    const pairedDeployed = new Set(pairs.map((pair) => pair.deployed));
    const pairedLocal = new Set(pairs.map((pair) => pair.local));
    return {
        pairs,
        deployedOnly: deployed.filter((path) => !pairedDeployed.has(path)),
        localOnly: local.filter((path) => !pairedLocal.has(path)),
    };
}

/**
 * Blanks comments that differ between builds of the same code (`sourceMappingURL`, `debugId`, license
 * banners that name the hashed file). They become spaces of the same length, so offsets stay valid.
 */
export function blankBuildComments(code: string): string {
    return code
        .replace(/\/\/[#@]\s*(?:sourceMappingURL|debugId)=\S+/g, (comment) => " ".repeat(comment.length))
        .replace(/\/\*!\s*For license information please see \S+ \*\//g, (comment) => " ".repeat(comment.length));
}

export interface Similarity {
    /** Share of the deployed file's probes found in the local file (0..1). */
    rate: number;
    probes: number;
    hits: number;
    /** Raw offsets in the deployed file where a probe was NOT found: where the code differs. */
    missedAt: number[];
}

/**
 * How much of the deployed file's code (identifiers collapsed) also occurs in the local file:
 * fixed-size probes every `step` characters, each looked up anywhere in the local text.
 */
export function chunkSimilarity(
    deployedCode: string,
    localCode: string,
    options: { probe?: number; step?: number } = {}
): Similarity {
    const probe = options.probe ?? 64;
    const step = options.step ?? 97;
    const deployedNorm = normalizeIdentifiers(blankBuildComments(deployedCode));
    const deployed = deployedNorm.text;
    const local = normalizeIdentifiers(blankBuildComments(localCode)).text;
    let hits = 0;
    let probes = 0;
    const missedAt: number[] = [];
    for (let at = 0; at + probe <= deployed.length; at += step) {
        probes++;
        if (local.includes(deployed.slice(at, at + probe))) {
            hits++;
        } else {
            missedAt.push(deployedNorm.rawOffsetOf[at]);
        }
    }

    return { rate: probes === 0 ? 1 : hits / probes, probes, hits, missedAt };
}

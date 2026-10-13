import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import { type NormalizedCode, normalizeIdentifiers } from "./align.ts";
import type { DeployedFile } from "./deployed.ts";
import { pairFilesByContent } from "./pair-content.ts";
import { localMapPath } from "./resolvers/shared.ts";
import { decodeMappings, type RawSourceMap } from "./source-map.ts";

const { log } = logger.scoped("ts:sourcemaps:carry");
const prof = profiler.scope("sourcemaps");

/** A stretch where the two normalized texts are equal: `length` characters from `from` in one, `to` in the other. */
export interface EqualRun {
    from: number;
    to: number;
    length: number;
}

const ANCHOR = 32;
const ANCHOR_STEP = 4;

function hashes(text: string, k: number): Int32Array {
    const count = Math.max(0, text.length - k + 1);
    const out = new Int32Array(count);
    let power = 1;
    for (let i = 0; i < k - 1; i++) {
        power = Math.imul(power, 31);
    }

    let hash = 0;
    for (let i = 0; i < text.length; i++) {
        if (i >= k) {
            hash = (hash - Math.imul(text.charCodeAt(i - k), power)) | 0;
        }

        hash = (Math.imul(hash, 31) + text.charCodeAt(i)) | 0;
        if (i >= k - 1) {
            out[i - k + 1] = hash;
        }
    }

    return out;
}

/** Indices of a longest strictly increasing subsequence of `values` (patience sorting, O(n log n)). */
function longestIncreasing(values: number[]): number[] {
    const tails: number[] = [];
    const previous = new Int32Array(values.length).fill(-1);
    for (let i = 0; i < values.length; i++) {
        let low = 0;
        let high = tails.length;
        while (low < high) {
            const mid = (low + high) >> 1;
            if ((values[tails[mid] as number] as number) < (values[i] as number)) {
                low = mid + 1;
            } else {
                high = mid;
            }
        }

        if (low > 0) {
            previous[i] = tails[low - 1] as number;
        }

        tails[low] = i;
    }

    const out: number[] = [];
    for (let at = tails.at(-1) ?? -1; at >= 0; at = previous[at] as number) {
        out.push(at);
    }

    return out.reverse();
}

/**
 * The equal stretches of two texts, in order: anchors are k-grams unique in `to`, kept when they form one
 * increasing chain (so moved code cannot cross), and each anchor grows left and right while the texts agree.
 * On identifier-normalized code this is the minified chunk's diff, at a cost close to linear.
 */
export function equalRuns(from: string, to: string): EqualRun[] {
    const toHashes = hashes(to, ANCHOR);
    const unique = new Map<number, number>();
    for (let i = 0; i < toHashes.length; i++) {
        const hash = toHashes[i] as number;
        unique.set(hash, unique.has(hash) ? -1 : i);
    }

    const fromHashes = hashes(from, ANCHOR);
    const anchorsFrom: number[] = [];
    const anchorsTo: number[] = [];
    for (let i = 0; i < fromHashes.length; i += ANCHOR_STEP) {
        const at = unique.get(fromHashes[i] as number);
        if (at !== undefined && at >= 0 && from.startsWith(to.slice(at, at + ANCHOR), i)) {
            anchorsFrom.push(i);
            anchorsTo.push(at);
        }
    }

    const chain = longestIncreasing(anchorsTo);
    const runs: EqualRun[] = [];
    let endFrom = 0;
    let endTo = 0;
    for (const index of chain) {
        const anchorFrom = anchorsFrom[index] as number;
        const anchorTo = anchorsTo[index] as number;
        if (anchorFrom < endFrom || anchorTo < endTo) {
            continue;
        }

        let start = 0;
        while (
            anchorFrom - start - 1 >= endFrom &&
            anchorTo - start - 1 >= endTo &&
            from.charCodeAt(anchorFrom - start - 1) === to.charCodeAt(anchorTo - start - 1)
        ) {
            start++;
        }

        let length = start;
        while (
            anchorFrom - start + length < from.length &&
            anchorTo - start + length < to.length &&
            from.charCodeAt(anchorFrom - start + length) === to.charCodeAt(anchorTo - start + length)
        ) {
            length++;
        }

        runs.push({ from: anchorFrom - start, to: anchorTo - start, length });
        endFrom = anchorFrom - start + length;
        endTo = anchorTo - start + length;
    }

    return runs;
}

/** The run that covers `offset` of the `from` text, or undefined. */
function runContaining(runs: EqualRun[], offset: number): EqualRun | undefined {
    let low = 0;
    let high = runs.length - 1;
    while (low <= high) {
        const mid = (low + high) >> 1;
        const run = runs[mid] as EqualRun;
        if (offset < run.from) {
            high = mid - 1;
        } else if (offset >= run.from + run.length) {
            low = mid + 1;
        } else {
            return run;
        }
    }

    return undefined;
}

function lineStarts(text: string): number[] {
    const starts = [0];
    for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
        starts.push(i + 1);
    }

    return starts;
}

function lineOf(starts: number[], offset: number): number {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
        const mid = (low + high + 1) >> 1;
        if ((starts[mid] as number) <= offset) {
            low = mid;
        } else {
            high = mid - 1;
        }
    }

    return low;
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function vlq(value: number): string {
    let rest = value < 0 ? (-value << 1) | 1 : value << 1;
    let out = "";
    do {
        let digit = rest & 31;
        rest >>>= 5;
        if (rest > 0) {
            digit |= 32;
        }

        out += BASE64[digit];
    } while (rest > 0);
    return out;
}

/** Encodes segments (`[column, source, line, column, name]`, -1 for absent) per generated line into `mappings`. */
export function encodeMappings(lines: number[][][]): string {
    let source = 0;
    let originalLine = 0;
    let originalColumn = 0;
    let name = 0;
    return lines
        .map((segments) => {
            let column = 0;
            return segments
                .map(([generated, src, line, col, nameIndex]) => {
                    let out = vlq((generated as number) - column);
                    column = generated as number;
                    if ((src as number) >= 0) {
                        out += vlq((src as number) - source) + vlq((line as number) - originalLine);
                        out += vlq((col as number) - originalColumn);
                        source = src as number;
                        originalLine = line as number;
                        originalColumn = col as number;
                        if ((nameIndex as number) >= 0) {
                            out += vlq((nameIndex as number) - name);
                            name = nameIndex as number;
                        }
                    }

                    return out;
                })
                .join(",");
        })
        .join(";");
}

export interface CarriedMap {
    map: RawSourceMap;
    /** Mapping segments in the local map, and how many landed in an equal stretch of the deployed chunk. */
    segments: number;
    carried: number;
    runs: number;
}

/**
 * A source map for the DEPLOYED chunk, made from a local build's map: both chunks are compared with identifiers
 * collapsed (mangled names differ between builds), and every local mapping that falls in an equal stretch is
 * moved to the same code in the deployed chunk. Mappings in code that differs are dropped, not guessed.
 */
export function carryMap(options: { deployedCode: string; localCode: string; localMap: RawSourceMap }): CarriedMap {
    const deployed: NormalizedCode = normalizeIdentifiers(options.deployedCode);
    const local: NormalizedCode = normalizeIdentifiers(options.localCode);
    const runs = equalRuns(local.text, deployed.text);
    const localLines = lineStarts(options.localCode);
    const deployedLines = lineStarts(options.deployedCode);
    const out: number[][][] = deployedLines.map(() => []);
    let segments = 0;
    let carried = 0;
    const usedRuns = new Set<EqualRun>();
    const decoded = decodeMappings(options.localMap.mappings);
    for (let line = 0; line < decoded.length; line++) {
        const fields = decoded[line] as Int32Array;
        for (let at = 0; at < fields.length; at += 5) {
            segments++;
            const raw = (localLines[line] ?? Number.POSITIVE_INFINITY) + (fields[at] as number);
            if (raw >= options.localCode.length) {
                continue;
            }

            const normalized = local.normOffsetOf[raw] as number;
            const current = runContaining(runs, normalized);
            if (!current) {
                continue;
            }

            const target = deployed.rawOffsetOf[current.to + (normalized - current.from)] as number;
            const targetLine = lineOf(deployedLines, target);
            (out[targetLine] as number[][]).push([
                target - (deployedLines[targetLine] as number),
                fields[at + 1] as number,
                fields[at + 2] as number,
                fields[at + 3] as number,
                fields[at + 4] as number,
            ]);
            usedRuns.add(current);
            carried++;
        }
    }

    // A consumer maps a column to the nearest segment at or before it on the line, so code that differs after an
    // equal run would inherit the run's last location. End every run that carried a mapping with an unmapped segment.
    for (const run of usedRuns) {
        const end = run.to + run.length;
        if (end >= deployed.rawOffsetOf.length) {
            continue;
        }

        const target = deployed.rawOffsetOf[end] as number;
        const targetLine = lineOf(deployedLines, target);
        (out[targetLine] as number[][]).push([target - (deployedLines[targetLine] as number), -1, -1, -1, -1]);
    }

    for (let line = 0; line < out.length; line++) {
        const sorted = (out[line] as number[][]).sort(
            (a, z) => (a[0] as number) - (z[0] as number) || (z[1] as number) - (a[1] as number)
        );
        // A mapped segment that starts where a run ended wins over that run's end marker.
        out[line] = sorted.filter(
            (segment, index) => (segment[1] as number) >= 0 || index === 0 || sorted[index - 1]?.[0] !== segment[0]
        );
    }

    const map: RawSourceMap = {
        version: 3,
        sources: options.localMap.sources,
        names: options.localMap.names ?? [],
        mappings: encodeMappings(out),
    };
    if (options.localMap.sourceRoot) {
        map.sourceRoot = options.localMap.sourceRoot;
    }

    if (options.localMap.sourcesContent) {
        map.sourcesContent = options.localMap.sourcesContent;
    }

    return { map, segments, carried, runs: runs.length };
}

export interface CarriedFile {
    url: string;
    /** Deployed path, and the carried map's path, both relative to the output folder. */
    path: string;
    mapPath: string;
    local: string;
    segments: number;
    carried: number;
}

export interface CarryResult {
    files: CarriedFile[];
    /** Deployed JS with no local chunk (or no local map) to carry from. */
    skipped: string[];
    ms: number;
}

/**
 * Writes a carried map for every deployed chunk that has a local counterpart with a map, plus `index.json`
 * (`{ files: { <url>: <map path> } }`) for `tools chrome-devtools intercept --map-dir`.
 */
export async function carryMaps(options: {
    deployed: { dir: string; files: DeployedFile[] };
    build: { dir: string; files: string[] };
    outDir: string;
}): Promise<CarryResult> {
    const stop = prof.start("carry.all");
    const started = performance.now();
    const jsFiles = options.deployed.files.filter((file) => /\.m?js$/.test(file.path));
    const pairing = await pairFilesByContent({
        deployedDir: options.deployed.dir,
        deployed: jsFiles.map((file) => file.path),
        localDir: options.build.dir,
        local: options.build.files,
    });
    const byPath = new Map(jsFiles.map((file) => [file.path, file]));
    const files: CarriedFile[] = [];
    const skipped = [...pairing.deployedOnly];
    for (const pair of pairing.pairs) {
        const file = byPath.get(pair.deployed) as DeployedFile;
        const [deployedCode, localCode] = await Promise.all([
            readFile(join(options.deployed.dir, pair.deployed), "utf8"),
            readFile(join(options.build.dir, pair.local), "utf8"),
        ]);
        const mapPath = await localMapPath(options.build.dir, pair.local, localCode);
        if (!mapPath) {
            skipped.push(pair.deployed);
            continue;
        }

        const localMap = SafeJSON.parse(await readFile(mapPath, "utf8"), { strict: true }) as RawSourceMap;
        const carried = prof.measure("carry.file", () => carryMap({ deployedCode, localCode, localMap }));
        carried.map.file = basename(pair.deployed);
        const outMap = `${pair.deployed}.map`;
        await mkdir(dirname(join(options.outDir, outMap)), { recursive: true });
        await writeFile(join(options.outDir, outMap), SafeJSON.stringify(carried.map));
        files.push({
            url: file.url,
            path: pair.deployed,
            mapPath: outMap,
            local: pair.local,
            segments: carried.segments,
            carried: carried.carried,
        });
    }

    await writeFile(
        join(options.outDir, "index.json"),
        SafeJSON.stringify({ files: Object.fromEntries(files.map((file) => [file.url, file.mapPath])) }, null, 2)
    );
    const ms = performance.now() - started;
    stop();
    log.info({ files: files.length, skipped: skipped.length, ms: Math.round(ms) }, "maps carried");
    return { files, skipped, ms };
}

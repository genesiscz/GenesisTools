import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import type { DeployedFile } from "./deployed.ts";
import { type ResolverChain, resolvePosition } from "./resolvers/index.ts";
import type { ResolveConfidence } from "./resolvers/types.ts";

const { log } = logger.scoped("ts:sourcemaps:calibrate");
const prof = profiler.scope("sourcemaps");

/** A string literal long and distinctive enough to name its own source line. */
const LITERAL = /"([A-Za-z][^"\\\n]{11,79})"/g;
const NOISE = /^[0-9a-f-]{32,}$|sentry|webpack|__/i;

/**
 * - `near`: the literal is in the source within ±3 lines of the answer.
 * - `elsewhere`: the answer has source text, and the literal is not near it.
 * - `unverifiable`: the answer carries no source text (the map has no `sourcesContent`).
 * - `unresolved`: no resolver answered.
 */
export type CalibrationVerdict = "near" | "elsewhere" | "unverifiable" | "unresolved";

export interface CalibrationSample {
    url: string;
    offset: number;
    literal: string;
    confidence: ResolveConfidence | null;
    resolver: string | null;
    verdict: CalibrationVerdict;
    /** `source:line` of the answer, when there is one. */
    answer: string | null;
}

export interface CalibrationTier {
    samples: number;
    near: number;
    elsewhere: number;
    unverifiable: number;
}

export interface Calibration {
    samples: number;
    unresolved: number;
    /** Why positions went unresolved: the last resolver's reason, grouped by its shape, most common first. */
    reasons: Array<{ count: number; example: string }>;
    /** By the confidence the resolver claimed, so a tier's word can be checked against its record here. */
    byConfidence: Partial<Record<ResolveConfidence, CalibrationTier>>;
    /** Up to 20 `elsewhere` samples, to look at. */
    misses: CalibrationSample[];
    files: number;
    ms: number;
}

/** Unique literals of one file, spread evenly over it, at most `limit`. */
export function sampleLiterals(code: string, limit: number): Array<{ offset: number; literal: string }> {
    const counts = new Map<string, number>();
    for (const match of code.matchAll(LITERAL)) {
        counts.set(match[1] as string, (counts.get(match[1] as string) ?? 0) + 1);
    }

    const unique = [...code.matchAll(LITERAL)]
        .filter((match) => counts.get(match[1] as string) === 1 && !NOISE.test(match[1] as string))
        .map((match) => ({ offset: (match.index ?? 0) + 1, literal: match[1] as string }));
    if (unique.length <= limit) {
        return unique;
    }

    const step = unique.length / limit;
    return Array.from({ length: limit }, (_, index) => unique[Math.floor(index * step)] as (typeof unique)[number]);
}

/**
 * Checks the resolver chain on THIS deployment, where no map gives the truth: sample unique string literals in
 * the deployed JS, resolve each one's position, and ask whether the literal is in the source near the answer.
 * Literals survive minification verbatim, so they are a ground truth the deployment carries by itself. A
 * literal-heavy region is easier than average, so read the result as an upper bound for code with no strings.
 */
export async function calibrate(options: {
    deployed: { dir: string; files: DeployedFile[] };
    resolvers: ResolverChain;
    perFile?: number;
    maxFiles?: number;
}): Promise<Calibration> {
    const stop = prof.start("calibrate");
    const started = performance.now();
    const perFile = options.perFile ?? 8;
    const jsFiles = options.deployed.files.filter((file) => /\.m?js$/.test(file.path));
    const files = options.maxFiles ? spread(jsFiles, options.maxFiles) : jsFiles;
    const byConfidence: Calibration["byConfidence"] = {};
    const misses: CalibrationSample[] = [];
    let samples = 0;
    let unresolved = 0;
    const reasons = new Map<string, { count: number; example: string }>();
    for (const file of files) {
        const code = await readFile(join(options.deployed.dir, file.path), "utf8");
        for (const { offset, literal } of sampleLiterals(code, perFile)) {
            samples++;
            const chain = await resolvePosition({ url: file.url, position: { offset } }, options.resolvers);
            const result = chain.result;
            if (!result) {
                unresolved++;
                const last = chain.attempts.at(-1);
                const example = last ? `${last.resolver}: ${last.reason ?? "no answer"}` : "no resolver ran";
                const shape = reasonShape(example);
                const entry = reasons.get(shape) ?? { count: 0, example };
                entry.count++;
                reasons.set(shape, entry);
                continue;
            }

            const tier = byConfidence[result.confidence] ?? { samples: 0, near: 0, elsewhere: 0, unverifiable: 0 };
            byConfidence[result.confidence] = tier;
            tier.samples++;
            const verdict: CalibrationVerdict = !result.excerpt
                ? "unverifiable"
                : result.excerpt.join("\n").includes(literal)
                  ? "near"
                  : "elsewhere";
            tier[verdict]++;
            if (verdict === "elsewhere" && misses.length < 20) {
                misses.push({
                    url: file.url,
                    offset,
                    literal,
                    confidence: result.confidence,
                    resolver: result.resolver,
                    verdict,
                    answer: `${result.source}:${result.line}`,
                });
            }
        }
    }

    const ms = performance.now() - started;
    stop();
    log.info({ files: files.length, samples, unresolved, ms: Math.round(ms) }, "calibration done");
    const byCount = [...reasons.values()].sort((a, b) => b.count - a.count);
    return { samples, unresolved, reasons: byCount, byConfidence, misses, files: files.length, ms };
}

/** A reason with its file names and numbers blanked, so one cause counts once however many files it hit. */
function reasonShape(reason: string): string {
    return reason.replace(/\S+\.(?:m?js|map)\b/g, "<file>").replace(/\d+/g, "<n>");
}

function spread<T>(items: T[], count: number): T[] {
    if (items.length <= count) {
        return items;
    }

    const step = items.length / count;
    return Array.from({ length: count }, (_, index) => items[Math.floor(index * step)] as T);
}

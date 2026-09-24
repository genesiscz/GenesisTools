import { UsageError } from "../format";
import { duplicatesAnalyser } from "./duplicates";
import { godFilesAnalyser } from "./godFiles";
import { longFunctionsAnalyser } from "./longFunctions";
import { paramBloatAnalyser } from "./paramBloat";
import { shadowedAnalyser } from "./shadowed";
import type { Analyser, AnalyserName, Recommendation, RefactorInput, Severity } from "./types";
import { unusedExportsAnalyser } from "./unusedExports";

export * from "./types";

export const ANALYSERS: Analyser[] = [
    duplicatesAnalyser,
    shadowedAnalyser,
    longFunctionsAnalyser,
    paramBloatAnalyser,
    godFilesAnalyser,
    unusedExportsAnalyser,
];

/**
 * What `--include` runs when the caller names nothing. `unused-exports` is left out on purpose:
 * it cannot see a consumer outside the scanned paths, so it is the one analyser that reports
 * something a reader must verify before acting on it.
 */
export const DEFAULT_ANALYSERS: AnalyserName[] = ["duplicates", "shadowed", "long-functions", "param-bloat"];

export const ANALYSER_NAMES: AnalyserName[] = ANALYSERS.map((analyser) => analyser.name);

export function resolveAnalysers(include: string | undefined): Analyser[] {
    if (include === undefined || include.trim() === "") {
        return ANALYSERS.filter((analyser) => DEFAULT_ANALYSERS.includes(analyser.name));
    }

    const wanted = include
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part !== "");

    if (wanted.includes("all")) {
        return ANALYSERS;
    }

    const unknown = wanted.filter((name) => !ANALYSER_NAMES.includes(name as AnalyserName));

    if (unknown.length > 0) {
        throw new UsageError(
            `Unknown analyser: ${unknown.join(", ")}. Use one of: ${ANALYSER_NAMES.join(", ")}, "all" or "help".`
        );
    }

    return ANALYSERS.filter((analyser) => wanted.includes(analyser.name));
}

export interface RefactorReport {
    analysers: AnalyserName[];
    recommendations: Recommendation[];
    bySeverity: Record<Severity, number>;
    savedLines: number;
    scanned: { files: number; symbols: number };
}

export function runRefactors(analysers: Analyser[], input: RefactorInput): RefactorReport {
    const recommendations = analysers
        .flatMap((analyser) => analyser.run(input))
        .sort((left, right) => right.score - left.score);

    const bySeverity: Record<Severity, number> = { high: 0, medium: 0, low: 0 };

    for (const recommendation of recommendations) {
        bySeverity[recommendation.severity] += 1;
    }

    return {
        analysers: analysers.map((analyser) => analyser.name),
        recommendations,
        bySeverity,
        savedLines: recommendations.reduce((total, recommendation) => total + recommendation.savedLines, 0),
        scanned: {
            files: input.entries.length,
            symbols: input.entries.reduce((total, entry) => total + entry.symbols.length, 0),
        },
    };
}

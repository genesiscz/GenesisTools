import { parameterCount, parameterTypes } from "../signature";
import type { Analyser, Recommendation } from "./types";

const FUNCTION_KINDS = new Set(["function", "method"]);

/**
 * A long positional parameter list. The interesting case is not the count on its own, it is
 * two neighbours of the same type: `(cwd: string, ref: string, path: string)` lets a caller
 * swap two arguments and still compile.
 */
export const paramBloatAnalyser: Analyser = {
    name: "param-bloat",
    summary: "A long positional parameter list, especially with same-typed neighbours",
    run: ({ entries, options }): Recommendation[] => {
        const maxParams = options.maxParams ?? 4;
        const recommendations: Recommendation[] = [];

        for (const entry of entries) {
            for (const symbol of entry.symbols) {
                if (!FUNCTION_KINDS.has(symbol.kind) || symbol.local === true) {
                    continue;
                }

                const count = parameterCount(symbol.signature);

                if (count <= maxParams) {
                    continue;
                }

                const types = parameterTypes(symbol.signature);
                let swappable = 0;

                for (let index = 1; index < types.length; index += 1) {
                    if (types[index] !== "" && types[index] === types[index - 1]) {
                        swappable += 1;
                    }
                }

                recommendations.push({
                    analyser: "param-bloat",
                    severity: swappable >= 2 || count >= maxParams + 4 ? "high" : swappable >= 1 ? "medium" : "low",
                    title: `\`${symbol.name}\` takes ${count} positional parameters`,
                    detail: [
                        `${count} parameters against a ${maxParams} budget`,
                        swappable > 0
                            ? `${swappable} adjacent pair${swappable === 1 ? "" : "s"} share a type, so a caller can swap them and still compile`
                            : "no two neighbours share a type",
                        symbol.signature,
                    ],
                    sites: [
                        { file: entry.file, startLine: symbol.startLine, endLine: symbol.endLine, name: symbol.name },
                    ],
                    action: "take one options object; keep the first one or two required arguments positional",
                    savedLines: 0,
                    score: Number((count * 3 + swappable * 12).toFixed(2)),
                });
            }
        }

        return recommendations.sort((left, right) => right.score - left.score).slice(0, options.limit ?? 25);
    },
};

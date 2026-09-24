import { analysedSignature, parameterCount } from "../signature";
import type { Analyser, Recommendation } from "./types";

const FUNCTION_KINDS = new Set(["function", "method"]);
const STRING_OR_COMMENT = /(["'`])(?:\\.|(?!\1)[^\\])*\1|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;

/**
 * The deepest brace nesting inside a declaration. String literals and comments are blanked
 * first, so a brace in a template literal or in prose does not read as a block.
 */
function nestingOf(text: string): number {
    const bare = text.replace(STRING_OR_COMMENT, " ");
    let depth = 0;
    let deepest = 0;

    for (const character of bare) {
        if (character === "{") {
            depth += 1;
            deepest = Math.max(deepest, depth);
        } else if (character === "}") {
            depth -= 1;
        }
    }

    // The declaration's own body is depth 1, which is not nesting.
    return Math.max(0, deepest - 1);
}

export const longFunctionsAnalyser: Analyser = {
    name: "long-functions",
    summary: "A function long enough or nested deep enough that a reader loses the thread",
    run: ({ entries, options }): Recommendation[] => {
        const maxLines = options.maxFunctionLines ?? 60;
        const recommendations: Recommendation[] = [];

        for (const entry of entries) {
            const lines = entry.text.split("\n");

            for (const symbol of entry.symbols) {
                if (!FUNCTION_KINDS.has(symbol.kind) || symbol.local === true) {
                    continue;
                }

                const span = symbol.endLine - symbol.startLine + 1;

                if (span <= maxLines) {
                    continue;
                }

                const declaration = lines.slice(symbol.startLine - 1, symbol.endLine).join("\n");
                const nesting = nestingOf(declaration);
                const parameters = parameterCount(analysedSignature(symbol));

                recommendations.push({
                    analyser: "long-functions",
                    severity: span > maxLines * 3 || nesting >= 5 ? "high" : span > maxLines * 2 ? "medium" : "low",
                    title: `\`${symbol.name}\` runs ${span} lines`,
                    detail: [
                        `${span} lines against a ${maxLines} line budget`,
                        `nested ${nesting} level${nesting === 1 ? "" : "s"} deep`,
                        `${parameters} parameter${parameters === 1 ? "" : "s"}`,
                    ],
                    sites: [
                        {
                            file: entry.file,
                            startLine: symbol.startLine,
                            endLine: symbol.endLine,
                            name: symbol.name,
                        },
                    ],
                    action:
                        nesting >= 4
                            ? "pull the deepest block into a named helper, so the outer function reads as steps"
                            : "split it at the blank-line groups; each group is usually one named step",
                    savedLines: 0,
                    score: Number((span + nesting * 15).toFixed(2)),
                });
            }
        }

        return recommendations.sort((left, right) => right.score - left.score).slice(0, options.limit ?? 25);
    },
};

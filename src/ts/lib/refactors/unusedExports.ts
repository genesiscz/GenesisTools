import { basename } from "node:path";
import type { Analyser, Recommendation } from "./types";

const ENTRY_FILES = new Set(["index.ts", "index.tsx", "main.ts", "cli.ts"]);
const SKIP_KINDS = new Set(["re-export", "call", "default"]);

/**
 * An export nothing in the scanned set imports.
 *
 * ⚠️ This one is evidence, not a verdict, and it is why the severity never rises above
 * `medium`. A name can be reached by `export *`, by a string key, by a consumer outside the
 * paths you scanned, or by a test that the walk skipped. Entry files are excluded outright,
 * because a CLI's own surface is meant to have no importer.
 */
export const unusedExportsAnalyser: Analyser = {
    name: "unused-exports",
    summary: "An exported name that nothing in the scanned paths imports",
    run: ({ entries, modules, options }): Recommendation[] => {
        const used = new Set<string>();
        let starReexports = 0;

        for (const module of modules.values()) {
            for (const site of [...module.imports, ...module.reexports]) {
                if (site.names.length === 0 && site.kind === "reexport") {
                    starReexports += 1;
                }

                for (const name of site.names) {
                    used.add(name);
                }
            }
        }

        const recommendations: Recommendation[] = [];

        for (const entry of entries) {
            if (ENTRY_FILES.has(basename(entry.file))) {
                continue;
            }

            const orphans = entry.symbols.filter(
                (symbol) =>
                    symbol.exported &&
                    symbol.depth === 0 &&
                    symbol.local !== true &&
                    !SKIP_KINDS.has(symbol.kind) &&
                    !used.has(symbol.name)
            );

            if (orphans.length === 0) {
                continue;
            }

            const savedLines = orphans.reduce((total, symbol) => total + (symbol.endLine - symbol.startLine + 1), 0);

            recommendations.push({
                analyser: "unused-exports",
                severity: orphans.length >= 5 ? "medium" : "low",
                title: `${entry.file} exports ${orphans.length} name${orphans.length === 1 ? "" : "s"} nothing imports`,
                detail: [
                    orphans.map((symbol) => `${symbol.name} (${symbol.kind}, L${symbol.startLine})`).join(", "),
                    starReexports > 0
                        ? `${starReexports} \`export *\` sites exist in the scan, so a name can be reached without being listed`
                        : "no `export *` in the scan, so the import list is complete for these paths",
                ],
                sites: orphans.map((symbol) => ({
                    file: entry.file,
                    startLine: symbol.startLine,
                    endLine: symbol.endLine,
                    name: symbol.name,
                })),
                action: "drop the `export` keyword, or delete the declaration once you confirm no outside caller",
                savedLines,
                score: Number((orphans.length * 2 + savedLines / 10).toFixed(2)),
            });
        }

        return recommendations.sort((left, right) => right.score - left.score).slice(0, options.limit ?? 25);
    },
};

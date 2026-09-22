import { basename, dirname, join, normalize } from "node:path";
import type { Analyser, Recommendation } from "./types";

const ENTRY_FILES = new Set(["index.ts", "index.tsx", "main.ts", "cli.ts"]);
const SKIP_KINDS = new Set(["re-export", "call", "default"]);

function withoutExtension(file: string): string {
    return file.replace(/\.[cm]?[jt]sx?$/, "");
}

/**
 * The scanned files an import specifier can mean. Relative specifiers resolve against the
 * importer; a bare or aliased one (`@app/x/y`, `@scope/pkg/x/y`) is matched by its trailing path,
 * because tsconfig aliases are not resolved here. When more than one file matches, all of them are
 * returned: this feeds a "nothing uses it" verdict, so the safe side is to count a use too often.
 */
export function resolveSpecifier(fromFile: string, specifier: string, files: readonly string[]): string[] {
    const known = new Map(files.map((file) => [withoutExtension(file), file]));

    if (specifier.startsWith(".")) {
        const base = withoutExtension(normalize(join(dirname(fromFile), specifier)));
        const hit = known.get(base) ?? known.get(join(base, "index"));

        return hit ? [hit] : [];
    }

    const segments = specifier.split("/");
    const tail = segments.slice(specifier.startsWith("@") ? 2 : 1).join("/");

    if (tail === "") {
        return [];
    }

    return files.filter((file) => {
        const bare = withoutExtension(file);

        return bare.endsWith(`/${tail}`) || bare.endsWith(`/${tail}/index`);
    });
}

/**
 * An export nothing in the scanned set imports.
 *
 * ⚠️ This one is evidence, not a verdict, and it is why the severity never rises above
 * `medium`. A name can be reached by a string key, by a consumer outside the paths you scanned,
 * or by a test that the walk skipped. Entry files are excluded outright, because a CLI's own
 * surface is meant to have no importer.
 *
 * 🛑 A namespace import (`import * as ns from "./x"`) and a star re-export (`export * from "./x"`)
 * consume the WHOLE target module, so every export of it counts as used. The parser reports both
 * as the name `*`, which the first version matched against nothing: it called every export of a
 * namespace-imported client dead, and its star-re-export counter looked for an empty name list and
 * never fired, so the caveat it prints always claimed there was no `export *` in the scan.
 */
export const unusedExportsAnalyser: Analyser = {
    name: "unused-exports",
    summary: "An exported name that nothing in the scanned paths imports",
    run: ({ entries, modules, options }): Recommendation[] => {
        const files = entries.map((entry) => entry.file);
        const used = new Set<string>();
        const wholeModules = new Set<string>();
        let unresolvedStars = 0;

        for (const [file, module] of modules) {
            for (const site of [...module.imports, ...module.reexports]) {
                for (const name of site.names) {
                    if (name !== "*") {
                        used.add(name);
                        continue;
                    }

                    const targets = resolveSpecifier(file, site.specifier, files);

                    if (targets.length === 0) {
                        unresolvedStars += 1;
                    }

                    for (const target of targets) {
                        wholeModules.add(target);
                    }
                }
            }
        }

        const recommendations: Recommendation[] = [];

        for (const entry of entries) {
            if (ENTRY_FILES.has(basename(entry.file)) || wholeModules.has(entry.file)) {
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
                    unresolvedStars > 0
                        ? `${unresolvedStars} namespace import(s) or \`export *\` point outside the scan, so a name can still be reached from there`
                        : "every namespace import and `export *` in the scan resolved to a scanned file",
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

import { declarationSimilarity } from "../duplicates";
import { analysedSignature, signatureSimilarity } from "../signature";
import type { SkeletonSymbol } from "../skeleton";
import { type Analyser, importedNames, isSharedModule, type Recommendation, type RefactorSite } from "./types";

interface Placed {
    file: string;
    text: string;
    symbol: SkeletonSymbol;
}

const CODE_KINDS = new Set(["function", "method", "const", "class"]);
/**
 * How alike the two declarations must look before a shared name counts as evidence.
 *
 * 🛑 An earlier version gated on nothing, on the reasoning that a badly drifted copy is the
 * worst case rather than the least interesting one. That reasoning was wrong, and it produced
 * the two findings this constant exists to stop: `data` in `figma/lib/kit.ts` "redefined 34
 * times" by an unrelated fixture object in every e2e spec, and five unrelated `renderMarkdown`
 * functions reported as copies of one another. Sharing a name is not sharing a job.
 */
const SHAPE_FLOOR = 0.5;

function declarationText(text: string, symbol: SkeletonSymbol): string {
    return text
        .split("\n")
        .slice(symbol.startLine - 1, symbol.endLine)
        .join("\n");
}

/**
 * A private helper whose name is already exported from a shared module. This is the shape
 * behind "we keep rewriting the same thing": the canonical version exists, the author did not
 * know, and a second copy appeared beside the call site.
 *
 * 🛑 The exported side must live in a SHARED module. Gating on the name alone flooded the
 * report with `main`, `run` and `log`, which every CLI entry point legitimately owns. Requiring
 * a `utils`/`lib`/`shared` home is what separates "there is a canonical one" from "this word
 * is common".
 */
export const shadowedAnalyser: Analyser = {
    name: "shadowed",
    summary: "A local helper whose name is already exported from a shared module",
    run: ({ entries, modules, options }): Recommendation[] => {
        const minLines = options.minLines ?? 3;
        // Every shared export of a name, not one winner per name.
        //
        // 🛑 Keeping a single home and breaking ties by body length lost the finding this
        // analyser exists for. Measured 2026-09-22 on a sibling repo: `src/update/lib/recovery.ts`
        // exports a 6-line async `git` returning a `{code, output}` object, `src/utils/
        // gitHelper.ts` exports a 3-line `git` returning a string, the longer one won, and
        // all sixteen private `git` helpers then failed the shape check against the wrong
        // home and vanished. Each copy now picks the home it actually resembles.
        const homes = new Map<string, Placed[]>();

        for (const entry of entries) {
            if (!isSharedModule(entry.file)) {
                continue;
            }

            for (const symbol of entry.symbols) {
                if (!symbol.exported || symbol.depth !== 0 || symbol.local === true || !CODE_KINDS.has(symbol.kind)) {
                    continue;
                }

                const placed: Placed = { file: entry.file, text: entry.text, symbol };
                const existing = homes.get(symbol.name);

                if (existing) {
                    existing.push(placed);
                } else {
                    homes.set(symbol.name, [placed]);
                }
            }
        }

        const byName = new Map<string, { home: Placed; copies: Placed[] }>();

        for (const entry of entries) {
            const imported = importedNames(modules.get(entry.file));

            for (const symbol of entry.symbols) {
                if (symbol.depth !== 0 && symbol.local !== true) {
                    continue;
                }

                // A copy is a PRIVATE declaration. An exported one is another home with importers
                // of its own; two shared modules exporting `git` used to be told to delete each other.
                if (symbol.exported) {
                    continue;
                }

                if (!CODE_KINDS.has(symbol.kind) || symbol.endLine - symbol.startLine + 1 < minLines) {
                    continue;
                }

                const candidates = homes.get(symbol.name);

                if (!candidates || imported.has(symbol.name)) {
                    continue;
                }

                const copyText = declarationText(entry.text, symbol);
                let home: Placed | null = null;
                let bestShape = 0;

                for (const candidate of candidates) {
                    // A `const` holding a fixture object is not a copy of an exported function
                    // that happens to share its name, whatever the name suggests.
                    if (candidate.file === entry.file || candidate.symbol.kind !== symbol.kind) {
                        continue;
                    }

                    const shape = Math.max(
                        signatureSimilarity(analysedSignature(candidate.symbol), analysedSignature(symbol)),
                        declarationSimilarity(
                            { text: declarationText(candidate.text, candidate.symbol), name: candidate.symbol.name },
                            { text: copyText, name: symbol.name }
                        )
                    );

                    if (shape > bestShape) {
                        bestShape = shape;
                        home = candidate;
                    }
                }

                if (home === null || bestShape < SHAPE_FLOOR) {
                    continue;
                }

                const key = `${home.file}:${symbol.name}`;
                const group = byName.get(key);

                if (group) {
                    group.copies.push({ file: entry.file, text: entry.text, symbol });
                } else {
                    byName.set(key, { home, copies: [{ file: entry.file, text: entry.text, symbol }] });
                }
            }
        }

        const recommendations: Recommendation[] = [];

        for (const { home, copies } of byName.values()) {
            const name = home.symbol.name;
            const homeText = declarationText(home.text, home.symbol);
            const bodyBest = Math.max(
                ...copies.map((copy) =>
                    declarationSimilarity(
                        { text: homeText, name },
                        { text: declarationText(copy.text, copy.symbol), name: copy.symbol.name }
                    )
                )
            );
            const shapeBest = Math.max(
                ...copies.map((copy) =>
                    signatureSimilarity(analysedSignature(home.symbol), analysedSignature(copy.symbol))
                )
            );
            const best = Math.max(bodyBest, shapeBest);
            const savedLines = copies.reduce(
                (total, copy) => total + (copy.symbol.endLine - copy.symbol.startLine + 1),
                0
            );
            const sites: RefactorSite[] = [
                {
                    file: home.file,
                    startLine: home.symbol.startLine,
                    endLine: home.symbol.endLine,
                    name,
                    canonical: true,
                },
                ...copies.map((copy) => ({
                    file: copy.file,
                    startLine: copy.symbol.startLine,
                    endLine: copy.symbol.endLine,
                    name: copy.symbol.name,
                })),
            ];

            recommendations.push({
                analyser: "shadowed",
                severity: copies.length >= 4 ? "high" : copies.length >= 2 ? "medium" : "low",
                title: `\`${name}\` is exported from ${home.file}, and redefined ${copies.length} time${copies.length === 1 ? "" : "s"}`,
                detail: [
                    `${home.file}:${home.symbol.startLine} — ${home.symbol.signature}`,
                    `closest copy: ${Math.round(shapeBest * 100)}% the same shape, ${Math.round(bodyBest * 100)}% the same body`,
                    bodyBest < 0.5
                        ? "the bodies have drifted, so check which behaviour each caller relies on"
                        : "the bodies are close enough to swap directly",
                ],
                sites,
                action: `import \`${name}\` from ${home.file} and delete the ${copies.length} private cop${copies.length === 1 ? "y" : "ies"}`,
                savedLines,
                score: Number((savedLines * (0.5 + best / 2) * (1 + copies.length / 10)).toFixed(2)),
            });
        }

        return recommendations.sort((left, right) => right.score - left.score).slice(0, options.limit ?? 25);
    },
};

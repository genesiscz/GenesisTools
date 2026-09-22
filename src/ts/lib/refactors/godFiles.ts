import type { Analyser, Recommendation } from "./types";

/** Longest shared leading word, so `renderTable` and `renderRow` cluster under `render`. */
function prefixOf(name: string): string {
    const match = name.match(/^(?:_)?([a-z]+|[A-Z][a-z]+)/);

    return match ? (match[1] as string).toLowerCase() : name.toLowerCase();
}

function clustersOf(names: string[]): { prefix: string; count: number }[] {
    const counts = new Map<string, number>();

    for (const name of names) {
        const prefix = prefixOf(name);

        counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
    }

    return [...counts.entries()]
        .filter(([, count]) => count >= 3)
        .map(([prefix, count]) => ({ prefix, count }))
        .sort((left, right) => right.count - left.count);
}

/**
 * A file carrying far more declarations than its neighbours. The cut-off is the greater of the
 * absolute budget and the tree's own 90th percentile, so a repo of large files does not report
 * every file, and a repo of small ones still surfaces its outlier.
 */
export const godFilesAnalyser: Analyser = {
    name: "god-files",
    summary: "A file holding far more declarations than the rest of the tree",
    run: ({ entries, options }): Recommendation[] => {
        const budget = options.maxDeclarations ?? 40;
        const counts = entries
            .map((entry) => entry.symbols.filter((symbol) => symbol.depth === 0 && symbol.local !== true).length)
            .sort((left, right) => left - right);

        if (counts.length === 0) {
            return [];
        }

        const p90 = counts[Math.min(counts.length - 1, Math.floor(counts.length * 0.9))] ?? 0;
        const floor = Math.max(budget, p90);
        const recommendations: Recommendation[] = [];

        for (const entry of entries) {
            const top = entry.symbols.filter((symbol) => symbol.depth === 0 && symbol.local !== true);

            if (top.length <= floor) {
                continue;
            }

            const totalLines = entry.text.split("\n").length;
            const clusters = clustersOf(top.map((symbol) => symbol.name));
            const exported = top.filter((symbol) => symbol.exported).length;

            recommendations.push({
                analyser: "god-files",
                severity: top.length > floor * 2 ? "high" : "medium",
                title: `${entry.file} holds ${top.length} top-level declarations`,
                detail: [
                    `${top.length} declarations over ${totalLines} lines, against a ${floor} declaration cut-off`,
                    `${exported} of them are exported, so ${top.length - exported} are private to this file`,
                    clusters.length > 0
                        ? `name clusters worth splitting on: ${clusters
                              .slice(0, 4)
                              .map((cluster) => `${cluster.prefix}* (${cluster.count})`)
                              .join(", ")}`
                        : "no shared name prefix, so split by what the declarations call instead",
                ],
                sites: [{ file: entry.file, startLine: 1, endLine: totalLines, name: entry.file }],
                action:
                    clusters.length > 0
                        ? `move the \`${clusters[0]?.prefix}*\` group into its own module and re-export it`
                        : "split by responsibility; run `tools ts imports cycles` first, so the split does not create one",
                savedLines: 0,
                score: Number((top.length * 2 + totalLines / 20).toFixed(2)),
            });
        }

        return recommendations.sort((left, right) => right.score - left.score).slice(0, options.limit ?? 25);
    },
};

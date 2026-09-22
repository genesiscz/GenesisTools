import { findDuplicates } from "../duplicates";
import type { Analyser, Recommendation, Severity } from "./types";

function severityOf(copies: number, wastedLines: number): Severity {
    if (copies >= 4 || wastedLines >= 40) {
        return "high";
    }

    return wastedLines >= 12 ? "medium" : "low";
}

export const duplicatesAnalyser: Analyser = {
    name: "duplicates",
    summary: "The same code written more than once, whether or not the copies share a name",
    run: ({ entries, options }): Recommendation[] => {
        const report = findDuplicates(entries, { ...options, recommend: true });

        return report.groups.slice(0, options.limit ?? 25).map((group) => {
            const canonical = group.canonical;
            const detail = [
                `${group.copies} copies, ${group.lines} lines each at most`,
                group.reason === "identical"
                    ? "the bodies are identical once comments and the declared name are removed"
                    : `the bodies are ${Math.round(group.similarity * 100)}% alike`,
            ];

            if (group.names.length > 1) {
                detail.push(`written under ${group.names.length} names: ${group.names.join(", ")}`);
            }

            if (canonical) {
                detail.push(`${canonical.file}:${canonical.startLine} is the best home for it`);
            }

            return {
                analyser: "duplicates",
                severity: severityOf(group.copies, group.wastedLines),
                title: `\`${group.names[0]}\` is defined ${group.copies} times`,
                detail,
                sites: group.members.map((member) => ({
                    file: member.file,
                    startLine: member.startLine,
                    endLine: member.endLine,
                    name: member.name,
                    ...(member === canonical ? { canonical: true } : {}),
                })),
                action: group.action ?? "lift one copy into a shared module and import it",
                savedLines: group.wastedLines,
                score: group.score,
            };
        });
    },
};

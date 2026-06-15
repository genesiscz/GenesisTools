import { withThousands } from "./roar";
import { faceForTier } from "./tier";
import type { MonsterReport } from "./types";

export function render(report: MonsterReport): string {
    if (report.scariest === null) {
        return "No monsters here — the repo is clean.";
    }

    const top = report.scariest;
    const lines: string[] = [];
    lines.push("");
    lines.push(faceForTier(top.tier));
    lines.push("");
    lines.push(`  ${top.tierName.toUpperCase()} (tier ${top.tier})`);
    lines.push(`  "${top.roar}"`);
    lines.push("");
    lines.push(`  Scariest file: ${top.path}   score ${top.score.toFixed(1)}`);
    lines.push("");
    lines.push(`  Leaderboard (top ${report.leaderboard.length} scariest)`);

    report.leaderboard.forEach((f, i) => {
        const rank = String(i + 1).padStart(2, " ");
        const stats = `${withThousands(f.lines)} lines · ${Math.round(f.ageDays)}d · in ${f.fanIn} / out ${f.fanOut}`;
        lines.push(`  ${rank}. ${f.path}   ${f.score.toFixed(1)}   ${stats}`);
    });

    lines.push("");
    lines.push(
        `  Repo monster size: ${withThousands(Math.round(report.repoMonsterSize))}  (sum of ${withThousands(report.fileCount)} files)`
    );
    lines.push("");

    return lines.join("\n");
}

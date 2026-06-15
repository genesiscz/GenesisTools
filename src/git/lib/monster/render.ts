import { formatTable } from "@app/utils/table";
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

/** Clean, professional repo-health report: ranked leaderboard table, repo totals, one-line summary. No ASCII art, no roar. */
export function renderHealth(report: MonsterReport): string {
    if (report.scariest === null) {
        return "Repo health: clean — no source files to score.";
    }

    const headers = ["#", "Score", "File", "Lines", "Age (d)", "In", "Out"];
    const rows = report.leaderboard.map((f, i) => [
        String(i + 1),
        f.score.toFixed(1),
        f.path,
        withThousands(f.lines),
        withThousands(Math.round(f.ageDays)),
        withThousands(f.fanIn),
        withThousands(f.fanOut),
    ]);
    const table = formatTable(rows, headers, { alignRight: [0, 1, 3, 4, 5, 6], maxColWidth: 80 });

    const top = report.scariest;
    const lines: string[] = [];
    lines.push(`Repo health — ${report.dir}`);
    lines.push("");
    lines.push(`Top ${report.leaderboard.length} files by complexity score:`);
    lines.push("");
    lines.push(table);
    lines.push("");
    lines.push(
        `Totals: ${withThousands(report.fileCount)} files scored · aggregate score ${withThousands(Math.round(report.repoMonsterSize))}`
    );
    lines.push(
        `Summary: highest-risk file is ${top.path} (score ${top.score.toFixed(1)}, ${withThousands(top.lines)} lines, ${top.fanIn} in / ${top.fanOut} out).`
    );

    return lines.join("\n");
}

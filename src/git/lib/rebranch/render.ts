/**
 * Human output for `rebranch plan`, `apply` and `verify`. Returns strings; the command decides
 * where they go.
 */

import { createBoxTable, truncateDisplay } from "@genesiscz/utils/table";
import pc from "picocolors";
import type { Analysis, CommitClass, PathGroup } from "./classify";
import type { ResolvedPlan } from "./plan";
import type { VerifyReport } from "./verify";

const short = (sha: string): string => sha.slice(0, 9);

function classCell(cls: CommitClass): string {
    if (cls === "IN") {
        return pc.green("IN");
    }

    if (cls === "MIXED") {
        return pc.yellow("MIXED");
    }

    return pc.dim("·");
}

export function analysisTable(analysis: Analysis, groups: PathGroup[]): string {
    const table = createBoxTable(["#", "commit", "subject", ...groups.map((g) => g.name), "note"]);

    analysis.commits.forEach((c, i) => {
        let note = "";

        if (c.groups.length === 0) {
            note = pc.red("no group");
        } else if (c.groups.length > 1) {
            note = pc.yellow("shared");
        }

        table.push([
            String(i + 1),
            short(c.sha),
            truncateDisplay(c.subject, 60),
            ...groups.map((g) => classCell(c.classes[g.name].class)),
            note,
        ]);
    });

    return table.toString();
}

export function analysisDetails(analysis: Analysis, groups: PathGroup[]): string[] {
    const lines: string[] = [];
    const mixed = analysis.commits.filter((c) => Object.values(c.classes).some((cls) => cls.class === "MIXED"));

    if (mixed.length > 0) {
        lines.push("", pc.bold("MIXED commits: decide whole, skip or paths-only for each group"));

        for (const c of mixed) {
            lines.push(`  ${short(c.sha)} ${c.subject}`);

            for (const g of groups) {
                const cls = c.classes[g.name];

                if (cls.class === "MIXED") {
                    lines.push(`    ${g.name}: keeps ${cls.groupPaths.join(", ")}`);
                    lines.push(`    ${" ".repeat(g.name.length)}  outside ${cls.outsidePaths.join(", ")}`);
                }
            }
        }
    }

    if (analysis.unassigned.length > 0) {
        lines.push("", pc.bold("In no group: add each to a group, or list it under skip to leave it out"));

        for (const c of analysis.unassigned) {
            const paths = c.paths.length > 0 ? c.paths.join(", ") : "(no paths)";
            lines.push(`  ${short(c.sha)} ${c.subject}  ${pc.dim(paths)}`);
        }
    }

    if (analysis.shared.length > 0) {
        lines.push("", pc.bold("In several groups:"));

        for (const c of analysis.shared) {
            lines.push(`  ${short(c.sha)} ${c.subject}  ${pc.dim(c.groups.join(", "))}`);
        }
    }

    return lines;
}

export function planGroupLines(plan: ResolvedPlan): string[] {
    const lines: string[] = [];

    for (const g of plan.groups) {
        const picks = g.picks.filter((p) => p.decision !== "skip");
        lines.push(`${pc.bold(g.branch)} (${g.name}: ${g.patterns.join(", ")}): ${picks.length} commit(s)`);

        for (const p of g.picks) {
            const tag = p.decision === "whole" ? "" : ` [${p.decision}]`;
            lines.push(`  ${short(p.sha)} ${p.subject}${pc.yellow(tag)}`);
        }
    }

    for (const sha of plan.skip) {
        lines.push(`skip ${short(sha)}`);
    }

    return lines;
}

const STATUS_LABEL: Record<string, string> = {
    differs: "DIFFERS",
    lost: "LOST",
    unverifiable: "UNVERIFIED",
    dropped: "dropped",
};

export function reportLines(report: VerifyReport, expectedFrom: string): string[] {
    const lines: string[] = [];
    const counts = new Map<string, number>();

    for (const p of report.paths) {
        counts.set(p.status, (counts.get(p.status) ?? 0) + 1);
    }

    const summary = [...counts.entries()].map(([status, n]) => `${n} ${status}`).join(", ");
    lines.push(`${report.paths.length} path(s) the source changed, checked against ${expectedFrom}: ${summary}`);

    for (const p of report.paths) {
        if (p.status === "ok") {
            if (p.sharedWith.length > 0) {
                lines.push(`  ${pc.yellow("shared")} ${p.path}: ${p.detail}`);
            }

            continue;
        }

        const label = p.status === "dropped" ? pc.dim(STATUS_LABEL[p.status]) : pc.red(STATUS_LABEL[p.status]);
        lines.push(`  ${label} ${p.path}: ${p.detail}`);
    }

    for (const e of report.extra) {
        lines.push(`  ${pc.red("EXTRA")} ${e.path}: ${e.group} changes it, the source never did`);
    }

    for (const s of report.stripped) {
        lines.push(`  ${pc.dim("paths-only")} ${s.group} ${short(s.sha)} left out: ${s.paths.join(", ")}`);
    }

    for (const s of report.skipped) {
        lines.push(`  ${pc.dim("skip")} ${s.group ?? "every group"} ${short(s.sha)} ${s.subject}`);
    }

    for (const c of report.unassigned) {
        lines.push(`  ${pc.red("no group")} ${short(c.sha)} ${c.subject}`);
    }

    lines.push(
        report.ok
            ? pc.green("verified: every change of the source is on a group branch, or left out on purpose")
            : pc.red("NOT verified: the lines in red name what the split lost or changed")
    );
    return lines;
}

/** Never run: printed for the person who decides to push. */
export function pushLines(plan: ResolvedPlan): string[] {
    const target = plan.base.replace(/^origin\//, "");
    return plan.groups.flatMap((g) => [
        `git push -u origin ${g.branch}`,
        `gh pr create --base ${target} --head ${g.branch} --title "<title>" --body-file <file>`,
    ]);
}

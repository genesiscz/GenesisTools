import type { Finding } from "@app/doctor/lib/types";
import { THEME } from "../theme";
import {
    applyRightAlign,
    cell,
    meta,
    rightAlignColumnIndexes,
    selectionCell,
    sevBadge,
    sliceAroundCursor,
} from "./shared";
import type { ActionableTable, ColumnSpec, StatusRow, ViewFn } from "./types";

const COLUMNS: ColumnSpec[] = [
    { header: "", weight: 0 },
    { header: "", weight: 0 },
    { header: "Issue", weight: 3 },
    { header: "Count", weight: 1, align: "right" },
    { header: "Detail", weight: 4 },
];

const RIGHT_ALIGN = rightAlignColumnIndexes(COLUMNS);

interface OutdatedPkgShape {
    name: unknown;
}

function notInstalledStatus(): StatusRow {
    return { label: "Homebrew", value: "not installed", valueFg: THEME.sevCautious };
}

function leavesStatus(finding: Finding): StatusRow {
    const m = meta(finding);
    const count = typeof m.count === "number" ? m.count : 0;

    return {
        label: "Homebrew",
        value: `${count} top-level packages`,
    };
}

function outdatedDetail(finding: Finding): string {
    const m = meta(finding);
    const outdated = Array.isArray(m.outdated) ? (m.outdated as OutdatedPkgShape[]) : [];
    const names = outdated
        .slice(0, 3)
        .map((item) => (typeof item.name === "string" ? item.name : null))
        .filter((value): value is string => value !== null);
    const suffix = outdated.length > 3 ? "…" : "";
    return names.length === 0 ? (finding.detail ?? "").trim() : `${names.join(", ")}${suffix}`;
}

function outdatedCount(finding: Finding): string {
    const m = meta(finding);
    const outdated = Array.isArray(m.outdated) ? m.outdated : [];
    return String(outdated.length);
}

export const brewView: ViewFn = ({ findings, selected, cursor, viewportRows }) => {
    const status: StatusRow[] = [];
    const actionableFindings: Finding[] = [];

    for (const finding of findings) {
        if (finding.id === "brew-not-installed") {
            status.push(notInstalledStatus());
            continue;
        }

        if (finding.id === "brew-many-leaves") {
            status.push(leavesStatus(finding));
            continue;
        }

        if (finding.actions.length === 0) {
            status.push({ label: finding.title, value: finding.detail ?? "" });
            continue;
        }

        actionableFindings.push(finding);
    }

    const slice = sliceAroundCursor(actionableFindings, cursor, viewportRows);

    const rows = slice.rows.map((finding, index) => {
        const highlight = slice.startIndex + index === cursor;
        const bg = highlight ? THEME.bgHighlight : undefined;
        const isOutdated = finding.id === "brew-outdated";

        return [
            selectionCell(finding, selected, bg),
            sevBadge(finding.severity, bg),
            cell(finding.title.trim(), THEME.fg, bg),
            cell(isOutdated ? outdatedCount(finding) : "", THEME.fgDim, bg),
            cell(isOutdated ? outdatedDetail(finding) : (finding.detail ?? "").trim(), THEME.fgDim, bg),
        ];
    });

    const actionable: ActionableTable = {
        columns: COLUMNS,
        rows: applyRightAlign(rows, RIGHT_ALIGN),
        findings: slice.rows,
        allFindings: actionableFindings,
    };

    return { status, actionable, total: findings.length };
};

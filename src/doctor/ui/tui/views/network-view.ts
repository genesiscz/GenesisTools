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
    { header: "Issue", weight: 2 },
    { header: "Count", weight: 1, align: "right" },
    { header: "Detail", weight: 4 },
];

const RIGHT_ALIGN = rightAlignColumnIndexes(COLUMNS);

function utunStatus(finding: Finding): StatusRow {
    const m = meta(finding);
    const count = typeof m.count === "number" ? m.count : 0;

    return {
        label: "utun interfaces",
        value: `${count} (VPN leftovers?)`,
        valueFg: THEME.fgDim,
    };
}

function issueName(finding: Finding): string {
    if (finding.id === "net-stuck-connections") {
        return "Stuck TCP";
    }

    if (finding.id === "net-dns-flush") {
        return "DNS cache";
    }

    return finding.title;
}

function detailText(finding: Finding): string {
    const m = meta(finding);
    const counts = m.counts;
    if (counts && typeof counts === "object") {
        const entries = Object.entries(counts as Record<string, unknown>)
            .filter(([, value]) => typeof value === "number")
            .map(([key, value]) => `${key.toLowerCase()}=${value as number}`);
        if (entries.length > 0) {
            return entries.join(" ");
        }
    }

    return (finding.detail ?? "").trim();
}

export const networkView: ViewFn = ({ findings, selected, cursor, viewportRows }) => {
    const status: StatusRow[] = [];
    const actionableFindings: Finding[] = [];

    for (const finding of findings) {
        if (finding.id === "net-utun-leftovers") {
            status.push(utunStatus(finding));
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
        const m = meta(finding);
        const countText = typeof m.count === "number" ? String(m.count) : "";

        return [
            selectionCell(finding, selected, bg),
            sevBadge(finding.severity, bg),
            cell(issueName(finding), THEME.fg, bg),
            cell(countText, THEME.fgDim, bg),
            cell(detailText(finding), THEME.fgDim, bg),
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

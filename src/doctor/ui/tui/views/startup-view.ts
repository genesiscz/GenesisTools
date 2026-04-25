import type { Finding } from "@app/doctor/lib/types";
import { THEME } from "../theme";
import { cell, meta, selectionCell, sevBadge, sliceAroundCursor } from "./shared";
import type { ActionableTable, ColumnSpec, StatusRow, ViewFn } from "./types";

const COLUMNS: ColumnSpec[] = [
    { header: "", weight: 0 },
    { header: "", weight: 0 },
    { header: "Kind", weight: 1 },
    { header: "Name", weight: 3 },
    { header: "Detail", weight: 3 },
];

function toAssertionStatus(finding: Finding): StatusRow {
    const m = meta(finding);
    const processName = typeof m.processName === "string" ? m.processName : finding.title;
    const kind = typeof m.kind === "string" ? m.kind : "";

    return {
        label: "Power assertion",
        value: kind.length > 0 ? `${processName} (${kind})` : processName,
    };
}

function kindLabel(finding: Finding): string {
    if (finding.id.startsWith("startup-broken-")) {
        return "Broken agent";
    }

    if (finding.id.startsWith("startup-item-")) {
        return "Startup item";
    }

    return "Startup";
}

export const startupView: ViewFn = ({ findings, selected, cursor, viewportRows }) => {
    const status: StatusRow[] = [];
    const actionableFindings: Finding[] = [];

    for (const finding of findings) {
        if (finding.id.startsWith("startup-assertion-")) {
            status.push(toAssertionStatus(finding));
            continue;
        }

        if (finding.actions.length === 0) {
            status.push({ label: finding.title, value: finding.detail ?? "" });
            continue;
        }

        actionableFindings.push(finding);
    }

    const slice = sliceAroundCursor(actionableFindings, cursor, viewportRows);

    const actionable: ActionableTable = {
        columns: COLUMNS,
        rows: slice.rows.map((finding, index) => {
            const highlight = slice.startIndex + index === cursor;
            const bg = highlight ? THEME.bgHighlight : undefined;
            const m = meta(finding);
            const name = typeof m.label === "string" && m.label.length > 0 ? m.label : finding.title;
            const detail = (finding.detail ?? "").trim();

            return [
                selectionCell(finding, selected, bg),
                sevBadge(finding.severity, bg),
                cell(kindLabel(finding), THEME.fg, bg),
                cell(name, THEME.fg, bg),
                cell(detail, THEME.fgDim, bg),
            ];
        }),
        findings: slice.rows,
        allFindings: actionableFindings,
    };

    return { status, actionable, total: findings.length };
};

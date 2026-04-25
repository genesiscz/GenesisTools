import { formatBytes } from "@app/doctor/lib/size";
import type { Finding } from "@app/doctor/lib/types";
import { THEME } from "../theme";
import { applyRightAlign, cell, rightAlignColumnIndexes, selectionCell, sevBadge, sliceAroundCursor } from "./shared";
import type { ActionableTable, ColumnSpec, StatusRow, ViewFn } from "./types";

const COLUMNS: ColumnSpec[] = [
    { header: "", weight: 0 },
    { header: "", weight: 0 },
    { header: "Title", weight: 4 },
    { header: "Size", weight: 1, align: "right" },
    { header: "Note", weight: 3 },
];

const RIGHT_ALIGN = rightAlignColumnIndexes(COLUMNS);

function toStatusRow(finding: Finding): StatusRow {
    return {
        label: finding.title,
        value: finding.detail ?? "",
    };
}

export const genericView: ViewFn = ({ findings, selected, cursor, viewportRows }) => {
    const status: StatusRow[] = [];
    const actionableFindings: Finding[] = [];

    for (const finding of findings) {
        if (finding.actions.length === 0) {
            status.push(toStatusRow(finding));
            continue;
        }

        actionableFindings.push(finding);
    }

    const slice = sliceAroundCursor(actionableFindings, cursor, viewportRows);

    const rows = slice.rows.map((finding, index) => {
        const highlight = slice.startIndex + index === cursor;
        const bg = highlight ? THEME.bgHighlight : undefined;

        return [
            selectionCell(finding, selected, bg),
            sevBadge(finding.severity, bg),
            cell(finding.title, THEME.fg, bg),
            cell(
                typeof finding.reclaimableBytes === "number" ? formatBytes(finding.reclaimableBytes) : "",
                THEME.fgDim,
                bg
            ),
            cell(finding.detail ?? "", THEME.fgDim, bg),
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

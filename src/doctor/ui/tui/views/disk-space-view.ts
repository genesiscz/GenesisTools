import { formatBytes } from "@app/doctor/lib/size";
import type { Finding } from "@app/doctor/lib/types";
import { THEME } from "../theme";
import {
    applyRightAlign,
    cell,
    formatAge,
    meta,
    rightAlignColumnIndexes,
    selectionCell,
    sevBadge,
    sliceAroundCursor,
    truncatePathLeft,
} from "./shared";
import type { ActionableTable, ColumnSpec, StatusRow, ViewFn } from "./types";

const COLUMNS: ColumnSpec[] = [
    { header: "", weight: 0 },
    { header: "", weight: 0 },
    { header: "Path", weight: 5 },
    { header: "Size", weight: 1, align: "right" },
    { header: "Modified", weight: 1 },
];

const RIGHT_ALIGN = rightAlignColumnIndexes(COLUMNS);

const PATH_MAX = 50;

function toStatusRow(finding: Finding): StatusRow {
    return {
        label: finding.title,
        value: finding.detail ?? "",
    };
}

export const diskSpaceView: ViewFn = ({ findings, selected, cursor, viewportRows }) => {
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
        const m = meta(finding);
        const path = typeof m.path === "string" ? m.path : finding.title;
        const sizeText = typeof finding.reclaimableBytes === "number" ? formatBytes(finding.reclaimableBytes) : "";
        const mtime = typeof m.mtime === "string" ? m.mtime : undefined;
        const ageText = formatAge(mtime);
        const isRecommendation = finding.id === "disk-install-fd";

        return [
            selectionCell(finding, selected, bg),
            sevBadge(finding.severity, bg),
            cell(truncatePathLeft(path, PATH_MAX), THEME.fg, bg),
            cell(isRecommendation ? "recommendation" : sizeText, THEME.fgDim, bg),
            cell(isRecommendation ? "" : ageText, THEME.fgDim, bg),
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

import { formatBytes } from "@app/doctor/lib/size";
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
    truncatePathLeft,
} from "./shared";
import type { ActionableTable, ColumnSpec, StatusRow, ViewFn } from "./types";

const COLUMNS: ColumnSpec[] = [
    { header: "", weight: 0 },
    { header: "", weight: 0 },
    { header: "Path", weight: 5 },
    { header: "Size", weight: 1, align: "right" },
    { header: "Extra", weight: 2 },
];

const RIGHT_ALIGN = rightAlignColumnIndexes(COLUMNS);

const PATH_MAX = 50;

function toStatusRow(finding: Finding): StatusRow {
    return {
        label: finding.title,
        value: finding.detail ?? "",
    };
}

function extraText(finding: Finding): string {
    if (finding.id === "sys-var-log") {
        const m = meta(finding);
        const paths = Array.isArray(m.paths) ? m.paths : [];
        return `${paths.length} file${paths.length === 1 ? "" : "s"}`;
    }

    return "";
}

export const systemCachesView: ViewFn = ({ findings, selected, cursor, viewportRows }) => {
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
        const bytes =
            typeof m.bytes === "number"
                ? m.bytes
                : typeof m.totalSize === "number"
                  ? m.totalSize
                  : (finding.reclaimableBytes ?? 0);
        const sizeText = bytes > 0 ? formatBytes(bytes) : "";
        const pathValue = typeof m.path === "string" ? m.path : finding.title;

        return [
            selectionCell(finding, selected, bg),
            sevBadge(finding.severity, bg),
            cell(truncatePathLeft(pathValue, PATH_MAX), THEME.fg, bg),
            cell(sizeText, THEME.fgDim, bg),
            cell(extraText(finding), THEME.fgDim, bg),
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

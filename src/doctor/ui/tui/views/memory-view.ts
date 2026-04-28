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
} from "./shared";
import type { ActionableTable, ColumnSpec, StatusRow, ViewFn } from "./types";

const COLUMNS: ColumnSpec[] = [
    { header: "", weight: 0 },
    { header: "", weight: 0 },
    { header: "Process", weight: 4 },
    { header: "RSS", weight: 1, align: "right" },
    { header: "PID", weight: 1 },
];

const RIGHT_ALIGN = rightAlignColumnIndexes(COLUMNS);

function pressureColor(level: string): string | undefined {
    if (level === "HIGH") {
        return THEME.sevDangerous;
    }

    if (level === "MED" || level === "MEDIUM") {
        return THEME.sevCautious;
    }

    if (level === "LOW") {
        return THEME.sevSafe;
    }

    return undefined;
}

function swapStatus(finding: Finding): StatusRow {
    const m = meta(finding);
    const swapRaw = m.swap;
    const swap = swapRaw && typeof swapRaw === "object" ? (swapRaw as Record<string, unknown>) : {};
    const used = typeof swap.usedBytes === "number" ? swap.usedBytes : 0;
    const total = typeof swap.totalBytes === "number" ? swap.totalBytes : 0;
    const pct = total > 0 ? Math.round((used / total) * 100) : 0;

    return {
        label: "Swap",
        value: `${formatBytes(used)} / ${formatBytes(total)}  ·  ${pct}%`,
        valueFg: pct > 80 ? THEME.sevDangerous : undefined,
    };
}

function pressureStatus(finding: Finding): StatusRow {
    const m = meta(finding);
    const vmRaw = m.vm;
    const vm = vmRaw && typeof vmRaw === "object" ? (vmRaw as Record<string, unknown>) : {};
    const level = typeof vm.pressure === "string" ? vm.pressure : deriveFromTitle(finding.title);

    return {
        label: "Memory pressure",
        value: level,
        valueFg: pressureColor(level),
    };
}

function deriveFromTitle(title: string): string {
    const match = title.match(/\b(LOW|MED|MEDIUM|HIGH)\b/i);
    return match ? match[1].toUpperCase() : "UNKNOWN";
}

export const memoryView: ViewFn = ({ findings, selected, cursor, viewportRows }) => {
    const status: StatusRow[] = [];
    const actionableFindings: Finding[] = [];

    for (const finding of findings) {
        if (finding.id === "mem-swap") {
            status.push(swapStatus(finding));
            continue;
        }

        if (finding.id === "mem-pressure") {
            status.push(pressureStatus(finding));
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
        const label =
            typeof m.label === "string" && m.label.length > 0
                ? m.label
                : typeof m.comm === "string"
                  ? m.comm
                  : finding.title;
        const rss = typeof m.rssBytes === "number" ? m.rssBytes : (finding.reclaimableBytes ?? 0);
        const pid = typeof m.pid === "number" ? String(m.pid) : "";

        return [
            selectionCell(finding, selected, bg),
            sevBadge(finding.severity, bg),
            cell(label, THEME.fg, bg),
            cell(rss > 0 ? formatBytes(rss) : "", THEME.fgDim, bg),
            cell(pid, THEME.fgDim, bg),
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

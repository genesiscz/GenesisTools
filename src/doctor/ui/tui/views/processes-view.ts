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
    { header: "CPU%", weight: 1, align: "right" },
    { header: "RSS", weight: 1, align: "right" },
    { header: "PIDs", weight: 2 },
];

const RIGHT_ALIGN = rightAlignColumnIndexes(COLUMNS);

function toZombieStatus(finding: Finding): StatusRow {
    const m = meta(finding);
    const pid = typeof m.pid === "number" ? m.pid : undefined;
    const ppid = typeof m.ppid === "number" ? m.ppid : undefined;
    const label = typeof m.label === "string" && m.label.length > 0 ? m.label : finding.title;
    const pidPart = pid === undefined ? label : `PID ${pid}`;
    const parentPart = ppid === undefined ? "" : `  ·  parent ${ppid}`;

    return {
        label: "Zombie",
        value: `${pidPart}${parentPart}`,
    };
}

export const processesView: ViewFn = ({ findings, selected, cursor, viewportRows }) => {
    const status: StatusRow[] = [];
    const actionableFindings: Finding[] = [];

    for (const finding of findings) {
        if (finding.id.startsWith("proc-zombie-")) {
            status.push(toZombieStatus(finding));
            continue;
        }

        actionableFindings.push(finding);
    }

    const slice = sliceAroundCursor(actionableFindings, cursor, viewportRows);

    const rows = slice.rows.map((finding, index) => {
        const highlight = slice.startIndex + index === cursor;
        const bg = highlight ? THEME.bgHighlight : undefined;
        const m = meta(finding);
        const nameValue = m.label ?? m.comm ?? finding.title;
        const name = typeof nameValue === "string" ? nameValue : finding.title;

        let cpuText = "";
        let rssText = "";
        let pidsText = "";

        if (finding.id.startsWith("proc-cpu-")) {
            cpuText = typeof m.cpu === "number" ? `${m.cpu.toFixed(1)}%` : "";
            pidsText = typeof m.pid === "number" ? `PID ${m.pid}` : "";
        } else if (finding.id.startsWith("proc-group-")) {
            rssText = typeof m.totalRss === "number" ? formatBytes(m.totalRss) : "";
            pidsText = typeof m.count === "number" ? `× ${m.count}` : "";
        }

        return [
            selectionCell(finding, selected, bg),
            sevBadge(finding.severity, bg),
            cell(name, THEME.fg, bg),
            cell(cpuText, THEME.fgDim, bg),
            cell(rssText, THEME.fgDim, bg),
            cell(pidsText, THEME.fgDim, bg),
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

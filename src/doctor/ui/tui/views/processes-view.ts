import { formatBytes } from "@app/doctor/lib/size";
import { THEME } from "../theme";
import { selectionCell, sevBadge, sliceAroundCursor } from "./shared";
import type { Cell, ViewFn } from "./types";

function meta(f: { metadata?: unknown }): Record<string, unknown> {
    return (f.metadata ?? {}) as Record<string, unknown>;
}

function cell(text: string, fg: string, bg?: string): Cell {
    return [{ text, fg, bg }];
}

export const processesView: ViewFn = ({ findings, selected, cursor, viewportRows }) => {
    const slice = sliceAroundCursor(findings, cursor, viewportRows);

    return {
        columns: [
            { header: "", weight: 0 },
            { header: "", weight: 0 },
            { header: "Process", weight: 4 },
            { header: "CPU%", weight: 1, align: "right" },
            { header: "RSS", weight: 1, align: "right" },
            { header: "PIDs", weight: 2 },
        ],
        rows: slice.rows.map((finding, index) => {
            const highlight = slice.startIndex + index === cursor;
            const bg = highlight ? THEME.bgHighlight : undefined;
            const m = meta(finding);
            const name = String(m.label ?? m.comm ?? finding.title);

            let cpuText = "";
            let rssText = "";
            let pidsText = "";

            if (finding.id.startsWith("proc-cpu-")) {
                cpuText = typeof m.cpu === "number" ? `${m.cpu.toFixed(1)}%` : "";
                pidsText = typeof m.pid === "number" ? String(m.pid) : "";
            } else if (finding.id.startsWith("proc-group-")) {
                rssText = typeof m.totalRss === "number" ? formatBytes(m.totalRss) : "";
                pidsText = typeof m.count === "number" ? `× ${m.count}` : "";
            } else if (finding.id.startsWith("proc-zombie-")) {
                pidsText = typeof m.pid === "number" ? String(m.pid) : "";
            }

            return [
                selectionCell(finding, selected, bg),
                sevBadge(finding.severity, bg),
                cell(name, THEME.fg, bg),
                cell(cpuText, THEME.fgDim, bg),
                cell(rssText, THEME.fgDim, bg),
                cell(pidsText, THEME.fgDim, bg),
            ];
        }),
        total: findings.length,
    };
};

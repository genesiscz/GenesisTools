import { formatBytes } from "@app/doctor/lib/size";
import { THEME } from "../theme";
import { selectionCell, sevBadge, sliceAroundCursor } from "./shared";
import type { ViewFn } from "./types";

export const genericView: ViewFn = ({ findings, selected, cursor, viewportRows }) => {
    const slice = sliceAroundCursor(findings, cursor, viewportRows);

    return {
        columns: [
            { header: "", weight: 0 },
            { header: "", weight: 0 },
            { header: "Title", weight: 4 },
            { header: "Size", weight: 1, align: "right" },
            { header: "Note", weight: 3 },
        ],
        rows: slice.rows.map((finding, index) => {
            const highlight = slice.startIndex + index === cursor;
            const bg = highlight ? THEME.bgHighlight : undefined;

            return [
                selectionCell(finding, selected, bg),
                sevBadge(finding.severity, bg),
                [{ text: finding.title, fg: THEME.fg, bg }],
                [
                    {
                        text: finding.reclaimableBytes ? formatBytes(finding.reclaimableBytes) : "",
                        fg: THEME.fgDim,
                        bg,
                    },
                ],
                [{ text: finding.detail ?? "", fg: THEME.fgDim, bg }],
            ];
        }),
        total: findings.length,
    };
};

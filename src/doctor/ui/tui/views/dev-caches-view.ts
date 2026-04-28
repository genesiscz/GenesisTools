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
    { header: "Cache", weight: 2 },
    { header: "Size", weight: 1, align: "right" },
    { header: "Path", weight: 4 },
];

const RIGHT_ALIGN = rightAlignColumnIndexes(COLUMNS);

const PATH_MAX = 50;

const ID_NAME_PREFIXES: Array<[prefix: string, name: string]> = [
    ["dev-node-modules-", "node_modules"],
    ["dev-xcode-derived", "Xcode DerivedData"],
    ["dev-brew-cache", "Homebrew cache"],
    ["dev-docker-", "Docker"],
    ["dev-sim-runtime-", "iOS simulators"],
    ["dev-global-cache-", "Package manager cache"],
];

function cacheName(finding: Finding): string {
    for (const [prefix, name] of ID_NAME_PREFIXES) {
        if (finding.id.startsWith(prefix)) {
            return name;
        }
    }

    return finding.title;
}

function toStatusRow(finding: Finding): StatusRow {
    return {
        label: finding.title,
        value: finding.detail ?? "",
    };
}

export const devCachesView: ViewFn = ({ findings, selected, cursor, viewportRows }) => {
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
        const bytes = typeof m.bytes === "number" ? m.bytes : (finding.reclaimableBytes ?? 0);
        const sizeText = bytes > 0 ? formatBytes(bytes) : "";
        const path = typeof m.path === "string" ? m.path : "";

        return [
            selectionCell(finding, selected, bg),
            sevBadge(finding.severity, bg),
            cell(cacheName(finding), THEME.fg, bg),
            cell(sizeText, THEME.fgDim, bg),
            cell(truncatePathLeft(path, PATH_MAX), THEME.fgDim, bg),
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

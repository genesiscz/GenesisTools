import { out } from "@app/logger";
import Table from "cli-table3";
import pc from "picocolors";

export interface TableOptions {
    alignRight?: number[]; // column indices to right-align
    maxColWidth?: number; // max column width before truncation (default: 50)
}

function truncateCell(value: string, maxWidth: number): string {
    if (value.length <= maxWidth) {
        return value;
    }
    return `${value.slice(0, maxWidth - 3)}...`;
}

/**
 * Plain padded text table (no box borders).
 * Good for dense dumps, non-TTY, and places that already wrap output themselves.
 */
export function formatTable(rows: string[][], headers: string[], options?: TableOptions): string {
    const maxColWidth = options?.maxColWidth ?? 50;
    const alignRight = new Set(options?.alignRight ?? []);

    // Calculate column widths from headers and all row values
    const colWidths = headers.map((h) => Math.min(h.length, maxColWidth));
    for (const row of rows) {
        for (let i = 0; i < row.length; i++) {
            const cellLen = Math.min(row[i].length, maxColWidth);
            if (colWidths[i] === undefined || cellLen > colWidths[i]) {
                colWidths[i] = cellLen;
            }
        }
    }

    function padCell(value: string, colIndex: number): string {
        const truncated = truncateCell(value, maxColWidth);
        const width = colWidths[colIndex];
        if (alignRight.has(colIndex)) {
            return truncated.padStart(width);
        }
        return truncated.padEnd(width);
    }

    // Build header row
    const headerLine = headers.map((h, i) => padCell(h, i)).join("  ");

    // Build separator line
    const separatorLine = colWidths.map((w) => "─".repeat(w)).join("  ");

    // Build data rows
    const dataLines = rows.map((row) => row.map((cell, i) => padCell(cell, i)).join("  "));

    return [headerLine, separatorLine, ...dataLines].join("\n");
}

/** Box-drawing charset shared by every port-style inventory table. */
export const BOX_TABLE_CHARS = {
    top: "─",
    "top-mid": "┬",
    "top-left": "┌",
    "top-right": "┐",
    bottom: "─",
    "bottom-mid": "┴",
    "bottom-left": "└",
    "bottom-right": "┘",
    left: "│",
    "left-mid": "├",
    mid: "─",
    "mid-mid": "┼",
    right: "│",
    "right-mid": "┤",
    middle: "│",
} as const;

const CLI_HEADER_TEXT_MAX_WIDTH = 31;

/**
 * Port-style boxed table (`cli-table3`).
 * Prefer for interactive inventory lists (`tools port`, `tools ai-proxy models`, …).
 *
 * Usage:
 * ```ts
 * const table = createBoxTable(["NAME", "STATUS"]);
 * table.push([pc.white("foo"), formatDotStatus("ok", "yes")]);
 * out.println(table.toString());
 * ```
 */
export function createBoxTable(headers: string[]): Table.Table {
    return new Table({
        chars: { ...BOX_TABLE_CHARS },
        head: headers.map((header) => pc.cyan(pc.bold(header))),
        style: {
            head: [],
            border: ["gray"],
            "padding-left": 1,
            "padding-right": 1,
        },
    });
}

/**
 * Truncate for table cells / header titles. Empty → em dash.
 * Uses a single-char ellipsis (`…`) so columns stay tight.
 */
export function truncateDisplay(value: string | null | undefined, max: number): string {
    if (!value) {
        return "—";
    }

    if (value.length <= max) {
        return value;
    }

    return `${value.slice(0, max - 1)}…`;
}

/**
 * Cyan title box printed via `out.println` (human stdout, not clack).
 * Reference look: `tools port`, `tools ai-proxy models`.
 */
export function renderCliHeader(title: string, subtitle: string): void {
    const border = pc.cyan(pc.bold(" │"));

    out.println();
    out.println(pc.cyan(pc.bold(" ┌─────────────────────────────────────┐")));
    out.println(
        `${border}${pc.white(pc.bold(`  ${truncateDisplay(title, CLI_HEADER_TEXT_MAX_WIDTH).padEnd(CLI_HEADER_TEXT_MAX_WIDTH)}`))}${pc.cyan(pc.bold("│"))}`
    );
    out.println(
        `${border}${pc.dim(`  ${truncateDisplay(subtitle, CLI_HEADER_TEXT_MAX_WIDTH).padEnd(CLI_HEADER_TEXT_MAX_WIDTH)}`)}${pc.cyan(pc.bold("│"))}`
    );
    out.println(pc.cyan(pc.bold(" └─────────────────────────────────────┘")));
    out.println();
}

/** Section label + underline (e.g. "Columns", "Location", "Result"). */
export function renderCliSection(title: string): void {
    out.println(pc.cyan(pc.bold(`  ${title}`)));
    out.println(pc.dim("  ──────────────────────"));
}

/** Dim key + value row under a section (`KEY` padded, then explanation). */
export function renderCliKeyRow(key: string, value: string, keyWidth = 10): void {
    out.println(`  ${pc.dim(key.padEnd(keyWidth))} ${value}`);
}

export type DotStatusKind = "ok" | "warn" | "err" | "dim";

/** Colored `● label` status cell used across inventory tables. */
export function formatDotStatus(kind: DotStatusKind, label: string): string {
    switch (kind) {
        case "ok":
            return `${pc.green("●")} ${pc.green(label)}`;
        case "warn":
            return `${pc.yellow("●")} ${pc.yellow(label)}`;
        case "err":
            return `${pc.red("●")} ${pc.red(label)}`;
        default:
            return `${pc.dim("●")} ${pc.dim(label)}`;
    }
}

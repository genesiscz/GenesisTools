import type { Finding } from "@app/doctor/lib/types";
import { THEME } from "../theme";
import type { Cell, ColumnSpec, Row } from "./types";

export function severityColor(sev: Finding["severity"]): string {
    if (sev === "safe") {
        return THEME.sevSafe;
    }

    if (sev === "cautious") {
        return THEME.sevCautious;
    }

    if (sev === "dangerous") {
        return THEME.sevDangerous;
    }

    return THEME.sevBlocked;
}

export function sevBadge(sev: Finding["severity"], bg?: string): Cell {
    return [{ text: "■", fg: severityColor(sev), bg }];
}

export function selectionCell(finding: Finding, selected: Set<string>, bg?: string): Cell {
    if (finding.severity === "blocked") {
        return [{ text: "[-]", fg: THEME.sevBlocked, bg }];
    }

    const on = selected.has(finding.id);
    return [{ text: on ? "[x]" : "[ ]", fg: on ? THEME.success : THEME.fgDim, bg }];
}

export function sliceAroundCursor<T>(items: T[], cursor: number, rows: number): { rows: T[]; startIndex: number } {
    if (items.length <= rows) {
        return { rows: items, startIndex: 0 };
    }

    const half = Math.floor(rows / 2);
    let start = Math.max(0, cursor - half);
    if (start + rows > items.length) {
        start = items.length - rows;
    }

    return { rows: items.slice(start, start + rows), startIndex: start };
}

export function cell(text: string, fg: string, bg?: string): Cell {
    return [{ text, fg, bg }];
}

export function meta(finding: { metadata?: unknown }): Record<string, unknown> {
    const value = finding.metadata;
    if (value && typeof value === "object") {
        return value as Record<string, unknown>;
    }

    return {};
}

export function truncatePathLeft(path: string, maxWidth: number): string {
    if (path.length <= maxWidth) {
        return path;
    }

    return `…${path.slice(-(maxWidth - 1))}`;
}

export function truncateRight(text: string, maxWidth: number): string {
    if (text.length <= maxWidth) {
        return text;
    }

    return `${text.slice(0, maxWidth - 1)}…`;
}

export function padLeft(text: string, width: number): string {
    if (text.length >= width) {
        return text;
    }

    return " ".repeat(width - text.length) + text;
}

export function rightAlignColumnIndexes(columns: ColumnSpec[]): number[] {
    const indexes: number[] = [];
    for (let i = 0; i < columns.length; i += 1) {
        if (columns[i]!.align === "right") {
            indexes.push(i);
        }
    }

    return indexes;
}

export function applyRightAlign(rows: Row[], columnIndexes: number[]): Row[] {
    if (rows.length === 0 || columnIndexes.length === 0) {
        return rows;
    }

    const widths = new Map<number, number>();
    for (const colIndex of columnIndexes) {
        let max = 0;
        for (const row of rows) {
            const cell = row[colIndex];
            if (!cell) {
                continue;
            }

            const text = cell.map((chunk) => chunk.text).join("");
            if (text.length > max) {
                max = text.length;
            }
        }
        widths.set(colIndex, max);
    }

    return rows.map((row) =>
        row.map((cell, colIndex) => {
            const width = widths.get(colIndex);
            if (width === undefined || cell.length === 0) {
                return cell;
            }

            const joined = cell.map((chunk) => chunk.text).join("");
            if (joined.length >= width) {
                return cell;
            }

            const pad = " ".repeat(width - joined.length);
            const first = cell[0]!;
            return [{ ...first, text: pad + first.text }, ...cell.slice(1)];
        })
    );
}

export function formatAge(iso: string | undefined): string {
    if (!iso) {
        return "";
    }

    const ms = Date.now() - Date.parse(iso);
    if (!Number.isFinite(ms)) {
        return "";
    }

    const days = Math.floor(ms / 86_400_000);
    if (days >= 7) {
        const weeks = Math.floor(days / 7);
        return `${weeks}w ago`;
    }

    if (days > 0) {
        return `${days}d ago`;
    }

    const hours = Math.floor(ms / 3_600_000);
    if (hours > 0) {
        return `${hours}h ago`;
    }

    return "recent";
}

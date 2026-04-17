import type { Finding } from "@app/doctor/lib/types";
import { THEME } from "../theme";
import type { Cell } from "./types";

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

export function sliceAroundCursor<T>(
    items: T[],
    cursor: number,
    rows: number,
): { rows: T[]; startIndex: number } {
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

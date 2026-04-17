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

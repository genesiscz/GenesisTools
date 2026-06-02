import type { TmuxPresetSummary } from "@dd/contract";

/**
 * Pure formatters for the tmux-presets screen. Reimplemented locally (NOT imported from `@app/*`) so
 * the RN bundle never drags web/server code in. Pure logic only — runs under `bun:test`.
 */

export const DASH = "—";

/** "3 sessions · 7 windows · 12 panes" (singular-aware). */
export function summaryLine(s: Pick<TmuxPresetSummary, "sessions" | "windows" | "panes">): string {
    const part = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? "" : "s"}`;
    return `${part(s.sessions, "session")} · ${part(s.windows, "window")} · ${part(s.panes, "pane")}`;
}

/** Human file size for the on-disk preset (KB/MB), em-dash on 0/negative. */
export function formatBytes(bytes: number): string {
    if (!bytes || bytes < 0) {
        return DASH;
    }

    if (bytes < 1024) {
        return `${bytes} B`;
    }

    const kb = bytes / 1024;
    if (kb < 1024) {
        return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
    }

    return `${(kb / 1024).toFixed(1)} MB`;
}

/** ISO → short local "Jun 2, 14:03"; em-dash on unparseable. */
export function formatCapturedAt(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) {
        return DASH;
    }

    return d.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    });
}

/** "N created · N skipped" (· N failed only when > 0) — the restore result banner copy. */
export function restoreOutcomeLine(result: { created: number; skipped: number; failed: number }): string {
    const base = `${result.created} created · ${result.skipped} skipped`;
    return result.failed > 0 ? `${base} · ${result.failed} failed` : base;
}

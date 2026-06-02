import type { DiskUsageEntry } from "@dd/contract";

/**
 * Pure formatters for the Disk Janitor screen. Reimplemented locally (NOT imported from `@app/*`) so
 * the RN bundle never drags web/server code in. Pure logic only — runs under `bun:test`.
 */

export const DASH = "—";

export interface RankedDiskEntry extends DiskUsageEntry {
    /** 0–100, this entry's bytes as a percentage of the largest entry (bar width). */
    pct: number;
}

/** Bytes → one-decimal GB/MB/KB. Negative/NaN → em dash. 0 renders as "0.0 KB". */
export function formatBytes(bytes: number): string {
    if (Number.isNaN(bytes) || bytes < 0) {
        return DASH;
    }

    const GB = 1024 ** 3;
    const MB = 1024 ** 2;
    const KB = 1024;

    if (bytes >= GB) {
        return `${(bytes / GB).toFixed(1)} GB`;
    }

    if (bytes >= MB) {
        return `${(bytes / MB).toFixed(1)} MB`;
    }

    return `${(bytes / KB).toFixed(1)} KB`;
}

/** Annotate each entry with `pct` = bytes/maxBytes×100. Preserves input order (already bytes-desc). */
export function withPercentOfMax(entries: DiskUsageEntry[]): RankedDiskEntry[] {
    const max = entries.reduce((m, e) => Math.max(m, e.bytes), 0);

    return entries.map((entry) => ({
        ...entry,
        pct: max > 0 ? Math.round((entry.bytes / max) * 100) : 0,
    }));
}

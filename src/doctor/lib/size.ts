import { run } from "./run";

/**
 * Decimal (SI) bytes, like the Finder, `diskutil` and the Genesis Disk Manager. Until 2026-10-14 this divided by 1024
 * and still printed "MB", so one 629,145,600-byte file read "600.0 MB" in a finding next to the Disk Manager's
 * "629 MB" for the same bytes.
 */
export function formatBytes(bytes: number): string {
    if (bytes < 1000) {
        return `${bytes} B`;
    }

    const units = ["KB", "MB", "GB", "TB", "PB"];
    let value = bytes / 1000;
    let unitIdx = 0;

    // 999.96 MB would print as "1000.0 MB": move up a unit before toFixed rounds into it.
    while (value >= 999.95 && unitIdx < units.length - 1) {
        value /= 1000;
        unitIdx++;
    }

    return `${value.toFixed(1)} ${units[unitIdx]}`;
}

export function sumBytes(items: Array<{ reclaimableBytes?: number }>): number {
    return items.reduce((acc, item) => acc + (item.reclaimableBytes ?? 0), 0);
}

export async function duBytes(path: string, opts: { timeoutMs?: number } = {}): Promise<number> {
    const res = await run("du", ["-sk", path], { timeoutMs: opts.timeoutMs ?? 15_000 });

    if (res.status !== 0 || res.timedOut) {
        return 0;
    }

    const kb = Number.parseInt(res.stdout.trim().split(/\s+/)[0] ?? "0", 10);
    return Number.isNaN(kb) ? 0 : kb * 1024;
}

export async function statBytes(path: string): Promise<number> {
    const res = await run("stat", ["-f", "%z", path]);

    if (res.status !== 0) {
        return 0;
    }

    const bytes = Number.parseInt(res.stdout.trim(), 10);
    return Number.isNaN(bytes) ? 0 : bytes;
}

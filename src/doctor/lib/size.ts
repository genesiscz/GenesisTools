import { spawnSync } from "node:child_process";

export function formatBytes(bytes: number): string {
    if (bytes < 1024) {
        return `${bytes} B`;
    }

    const units = ["KB", "MB", "GB", "TB", "PB"];
    let value = bytes / 1024;
    let unitIdx = 0;

    while (value >= 1024 && unitIdx < units.length - 1) {
        value /= 1024;
        unitIdx++;
    }

    return `${value.toFixed(1)} ${units[unitIdx]}`;
}

export function sumBytes(items: Array<{ reclaimableBytes?: number }>): number {
    return items.reduce((acc, item) => acc + (item.reclaimableBytes ?? 0), 0);
}

export function duBytes(path: string): number {
    const res = spawnSync("du", ["-sk", path], { encoding: "utf8" });

    if (res.status !== 0) {
        return 0;
    }

    const kb = Number.parseInt(res.stdout.trim().split(/\s+/)[0] ?? "0", 10);
    return Number.isNaN(kb) ? 0 : kb * 1024;
}

export function statBytes(path: string): number {
    const res = spawnSync("stat", ["-f", "%z", path], { encoding: "utf8" });

    if (res.status !== 0) {
        return 0;
    }

    const bytes = Number.parseInt(res.stdout.trim(), 10);
    return Number.isNaN(bytes) ? 0 : bytes;
}

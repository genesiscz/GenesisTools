import type { SystemSwap } from "./types";

const UNIT_MULT: Record<string, number> = {
    K: 1024,
    M: 1024 ** 2,
    G: 1024 ** 3,
};

function unitToBytes(value: number, unit: string): number {
    return value * (UNIT_MULT[unit.toUpperCase()] ?? 1);
}

export function parseSwapUsage(output: string): SystemSwap {
    const empty: SystemSwap = { totalBytes: 0, usedBytes: 0, freeBytes: 0 };
    const m = output.match(/total\s*=\s*([\d.]+)([KMG])\s+used\s*=\s*([\d.]+)([KMG])\s+free\s*=\s*([\d.]+)([KMG])/);

    if (!m) {
        return empty;
    }

    return {
        totalBytes: unitToBytes(Number.parseFloat(m[1]), m[2]),
        usedBytes: unitToBytes(Number.parseFloat(m[3]), m[4]),
        freeBytes: unitToBytes(Number.parseFloat(m[5]), m[6]),
    };
}

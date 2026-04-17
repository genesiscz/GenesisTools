import { Analyzer } from "@app/doctor/lib/analyzer";
import type { AnalyzerCategory, AnalyzerContext, Finding } from "@app/doctor/lib/types";

export interface VmStatParsed {
    pageSize: number;
    free: number;
    active: number;
    inactive: number;
    speculative: number;
    wired: number;
    compressed: number;
    freeBytes: number;
    activeBytes: number;
    inactiveBytes: number;
    wiredBytes: number;
    compressedBytes: number;
}

export interface SwapusageParsed {
    totalBytes: number;
    usedBytes: number;
    freeBytes: number;
    encrypted: boolean;
}

function parsePageCount(raw: string, label: string): number {
    const re = new RegExp(`^${label}:\\s+(\\d+)\\.?$`, "m");
    const match = raw.match(re);

    if (!match) {
        return 0;
    }

    return Number.parseInt(match[1], 10);
}

export function parseVmStat(raw: string): VmStatParsed {
    const headerMatch = raw.match(/page size of (\d+) bytes/);
    const pageSize = headerMatch ? Number.parseInt(headerMatch[1], 10) : 4096;
    const free = parsePageCount(raw, "Pages free");
    const active = parsePageCount(raw, "Pages active");
    const inactive = parsePageCount(raw, "Pages inactive");
    const speculative = parsePageCount(raw, "Pages speculative");
    const wired = parsePageCount(raw, "Pages wired down");
    const compressed = parsePageCount(raw, "Pages occupied by compressor");

    return {
        pageSize,
        free,
        active,
        inactive,
        speculative,
        wired,
        compressed,
        freeBytes: free * pageSize,
        activeBytes: active * pageSize,
        inactiveBytes: inactive * pageSize,
        wiredBytes: wired * pageSize,
        compressedBytes: compressed * pageSize,
    };
}

export function parseSwapusage(raw: string): SwapusageParsed {
    const match = raw.match(/total = ([\d.]+)M\s+used = ([\d.]+)M\s+free = ([\d.]+)M(\s+\(encrypted\))?/);

    if (!match) {
        return { totalBytes: 0, usedBytes: 0, freeBytes: 0, encrypted: false };
    }

    const toBytes = (mb: string): number => Math.round(Number.parseFloat(mb) * 1024 * 1024);

    return {
        totalBytes: toBytes(match[1]),
        usedBytes: toBytes(match[2]),
        freeBytes: toBytes(match[3]),
        encrypted: Boolean(match[4]),
    };
}

export class MemoryAnalyzer extends Analyzer {
    readonly id = "memory";
    readonly name = "Memory";
    readonly icon = "M";
    readonly category: AnalyzerCategory = "memory";
    readonly cacheTtlMs = 0;

    protected async *run(_ctx: AnalyzerContext): AsyncIterable<Finding> {
        return;
    }
}

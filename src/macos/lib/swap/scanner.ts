import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { listProcessesWithUsage, readExecutablePath } from "@genesiscz/utils/process/processes";
import type { ProcessSwap, ScanOptions, ScanResult, SystemSwap } from "./types";

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

export interface PsRow {
    pid: number;
    rssBytes: number;
    uptimeMs: number;
    name: string;
}

export function parseVmmapSwap(output: string): number {
    for (const line of output.split("\n")) {
        if (!line.startsWith("Writable regions:")) {
            continue;
        }

        const m = line.match(/swapped_out=([\d.]+)\s*([KMG])?/);

        if (!m) {
            return 0;
        }

        const value = Number.parseFloat(m[1]);
        const unit = m[2] ?? "";
        return value * (UNIT_MULT[unit.toUpperCase()] ?? 1);
    }

    return 0;
}

const VMMAP_TIMEOUT_MS = 4000;
const VMMAP_CONCURRENCY = 32;
const RSS_FLOOR_BYTES = 25 * 1024 * 1024;
const CACHE_TTL_MS = 2 * 60 * 1000;
const START_TIME_TOLERANCE_MS = 5000;
const CACHE_PATH = join(env.tools.getHome(), ".genesis-tools", "macos-swap", "cache.json");

interface CachedEntry {
    pid: number;
    name: string;
    swapBytes: number;
    startTimeMs: number;
    cachedAt: number;
}

interface CacheFile {
    entries: CachedEntry[];
}

async function loadCache(): Promise<Map<number, CachedEntry>> {
    const map = new Map<number, CachedEntry>();

    try {
        const text = await Bun.file(CACHE_PATH).text();
        const data = SafeJSON.parse(text) as CacheFile;
        const now = Date.now();

        for (const entry of data.entries ?? []) {
            if (now - entry.cachedAt < CACHE_TTL_MS) {
                map.set(entry.pid, entry);
            }
        }
    } catch {
        // missing or corrupt cache — treat as empty
    }

    return map;
}

async function saveCache(entries: CachedEntry[]): Promise<void> {
    try {
        mkdirSync(dirname(CACHE_PATH), { recursive: true });
        await Bun.write(CACHE_PATH, SafeJSON.stringify({ entries }));
    } catch {
        // cache is best-effort; don't fail the scan if disk is full
    }
}

function sameProcess(cachedStart: number, currentStart: number): boolean {
    return Math.abs(cachedStart - currentStart) < START_TIME_TOLERANCE_MS;
}

async function spawn(cmd: string[], timeoutMs?: number): Promise<{ stdout: string; exitCode: number }> {
    const proc = Bun.spawn({ cmd, stdio: ["ignore", "pipe", "ignore"] });
    let timer: ReturnType<typeof setTimeout> | undefined;

    if (timeoutMs !== undefined) {
        timer = setTimeout(() => proc.kill(), timeoutMs);
    }

    try {
        const stdout = await new Response(proc.stdout).text();
        const exitCode = await proc.exited;
        return { stdout, exitCode };
    } finally {
        if (timer) {
            clearTimeout(timer);
        }
    }
}

async function getSystemSwap(): Promise<SystemSwap> {
    const { stdout, exitCode } = await spawn(["sysctl", "vm.swapusage"]);

    if (exitCode !== 0) {
        throw new Error(`sysctl vm.swapusage failed with exit code ${exitCode}`);
    }

    return parseSwapUsage(stdout);
}

export function readSwapProcessRows(
    readers: {
        processes?: typeof listProcessesWithUsage;
        executablePath?: typeof readExecutablePath;
        now?: () => number;
    } = {}
): PsRow[] {
    const entries = (readers.processes ?? listProcessesWithUsage)({ otherUsers: true });

    if (entries.length === 0) {
        throw new Error("swap process table unavailable");
    }

    const now = (readers.now ?? Date.now)();
    const executablePath = readers.executablePath ?? readExecutablePath;

    return entries.flatMap((entry): PsRow[] => {
        // Without a start time there is no reliable identity for the per-pid swap cache.
        if (entry.usage === null || entry.startMs === null) {
            return [];
        }

        // The executable path preserves spaces in app names and excludes command arguments.
        const name = executablePath(entry.pid) ?? (entry.command?.split(/\s+/)[0] || entry.name);
        return [
            {
                pid: entry.pid,
                rssBytes: entry.usage.rssBytes,
                // Match ps etime's whole seconds: reconstructed starts stay within the 5 s cache tolerance.
                uptimeMs: Math.max(0, Math.floor((now - entry.startMs) / 1000) * 1000),
                name,
            },
        ];
    });
}

interface ProbeResult {
    swapBytes: number;
    accessible: boolean;
}

async function getProcSwap(pid: number): Promise<ProbeResult> {
    const { stdout, exitCode } = await spawn(["vmmap", "-summary", String(pid)], VMMAP_TIMEOUT_MS);

    if (exitCode !== 0) {
        return { swapBytes: 0, accessible: false };
    }

    return { swapBytes: parseVmmapSwap(stdout), accessible: true };
}

async function pool<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let cursor = 0;

    async function run(): Promise<void> {
        while (cursor < items.length) {
            const i = cursor++;
            results[i] = await worker(items[i]);
        }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
    return results;
}

export async function scan(options: ScanOptions): Promise<ScanResult> {
    const [system, psRows, cache] = await Promise.all([
        getSystemSwap(),
        Promise.resolve().then(() => readSwapProcessRows()),
        loadCache(),
    ]);
    const now = Date.now();

    const sortedByRss = [...psRows].sort((a, b) => b.rssBytes - a.rssBytes);
    const candidates = options.all
        ? sortedByRss.filter((row) => row.rssBytes >= RSS_FLOOR_BYTES)
        : sortedByRss.slice(0, options.limit);

    const cacheHitEntries: ProcessSwap[] = [];
    const toScan: PsRow[] = [];

    for (const row of candidates) {
        const cached = cache.get(row.pid);
        const currentStart = now - row.uptimeMs;

        if (cached && sameProcess(cached.startTimeMs, currentStart)) {
            cacheHitEntries.push({
                pid: row.pid,
                name: row.name,
                rssBytes: row.rssBytes,
                swapBytes: cached.swapBytes,
                uptimeMs: row.uptimeMs,
            });
        } else {
            toScan.push(row);
        }
    }

    const freshProbes = await pool(toScan, VMMAP_CONCURRENCY, (row) => getProcSwap(row.pid));
    const freshEntries: ProcessSwap[] = toScan.map((row, i) => ({
        pid: row.pid,
        name: row.name,
        rssBytes: row.rssBytes,
        swapBytes: freshProbes[i].swapBytes,
        uptimeMs: row.uptimeMs,
    }));
    const inaccessibleCount = freshProbes.filter((probe) => !probe.accessible).length;

    const livePids = new Set(psRows.map((r) => r.pid));
    const newCacheEntries: CachedEntry[] = toScan
        .map((row, i) => ({ row, probe: freshProbes[i] }))
        .filter(({ probe }) => probe.accessible)
        .map(({ row, probe }) => ({
            pid: row.pid,
            name: row.name,
            swapBytes: probe.swapBytes,
            startTimeMs: now - row.uptimeMs,
            cachedAt: now,
        }));
    const rescannedPids = new Set(toScan.map((row) => row.pid));

    const survivingCacheEntries: CachedEntry[] = [];

    for (const entry of cache.values()) {
        if (!livePids.has(entry.pid) || rescannedPids.has(entry.pid)) {
            continue;
        }

        survivingCacheEntries.push(entry);
    }

    void saveCache([...newCacheEntries, ...survivingCacheEntries]);

    const processes: ProcessSwap[] = [...cacheHitEntries, ...freshEntries].filter((p) => p.swapBytes > 0);

    return {
        system,
        processes,
        scannedCount: candidates.length,
        totalProcesses: psRows.length,
        cacheHits: cacheHitEntries.length,
        freshScans: toScan.length,
        inaccessibleCount,
        wasAllMode: options.all,
    };
}

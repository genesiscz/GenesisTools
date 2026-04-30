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

export function parseEtime(etime: string): number {
    const trimmed = etime.trim();
    const match = trimmed.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);

    if (!match) {
        return 0;
    }

    const days = match[1] ? Number.parseInt(match[1], 10) : 0;
    const hours = match[2] ? Number.parseInt(match[2], 10) : 0;
    const minutes = Number.parseInt(match[3], 10);
    const seconds = Number.parseInt(match[4], 10);
    return (days * 86400 + hours * 3600 + minutes * 60 + seconds) * 1000;
}

export interface PsRow {
    pid: number;
    rssBytes: number;
    uptimeMs: number;
    name: string;
}

export function parsePsOutput(output: string): PsRow[] {
    const rows: PsRow[] = [];

    for (const raw of output.split("\n")) {
        const line = raw.trim();

        if (line === "") {
            continue;
        }

        const parts = line.split(/\s+/);

        if (parts.length < 4) {
            continue;
        }

        const pid = Number.parseInt(parts[0], 10);
        const rssKb = Number.parseInt(parts[1], 10);

        if (Number.isNaN(pid) || Number.isNaN(rssKb)) {
            continue;
        }

        const etime = parts[2];
        const name = parts.slice(3).join(" ");

        rows.push({
            pid,
            rssBytes: rssKb * 1024,
            uptimeMs: parseEtime(etime),
            name,
        });
    }

    return rows;
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

async function spawn(cmd: string[], timeoutMs?: number): Promise<{ stdout: string; exitCode: number }> {
    const proc = Bun.spawn({ cmd, stdio: ["ignore", "pipe", "pipe"] });
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
    const { stdout } = await spawn(["sysctl", "vm.swapusage"]);
    return parseSwapUsage(stdout);
}

async function getAllPsRows(): Promise<PsRow[]> {
    const { stdout } = await spawn(["ps", "-A", "-o", "pid=,rss=,etime=,comm="]);
    return parsePsOutput(stdout);
}

async function getProcSwap(pid: number): Promise<number> {
    const { stdout, exitCode } = await spawn(["vmmap", "-summary", String(pid)], VMMAP_TIMEOUT_MS);

    if (exitCode !== 0) {
        return 0;
    }

    return parseVmmapSwap(stdout);
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
    const [system, psRows] = await Promise.all([getSystemSwap(), getAllPsRows()]);

    const sortedByRss = [...psRows].sort((a, b) => b.rssBytes - a.rssBytes);
    const candidates = options.all
        ? sortedByRss.filter((row) => row.rssBytes >= RSS_FLOOR_BYTES)
        : sortedByRss.slice(0, options.limit);

    const swaps = await pool(candidates, VMMAP_CONCURRENCY, (row) => getProcSwap(row.pid));

    const processes: ProcessSwap[] = candidates
        .map((row, i) => ({
            pid: row.pid,
            name: row.name,
            rssBytes: row.rssBytes,
            swapBytes: swaps[i],
            uptimeMs: row.uptimeMs,
        }))
        .filter((entry) => entry.swapBytes > 0);

    return {
        system,
        processes,
        scannedCount: candidates.length,
        totalProcesses: psRows.length,
    };
}

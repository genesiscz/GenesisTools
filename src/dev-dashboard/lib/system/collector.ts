import { parseSwapUsage } from "@app/macos/lib/swap/scanner";
import { collectProcesses, sortProcesses } from "./processes";
import type { PulseSnapshot, TopProcess } from "./types";

export function parseCpuIdlePct(topOut: string): number | null {
    const m = topOut.match(/CPU usage:.*?([\d.]+)%\s+idle/);

    if (!m) {
        return null;
    }

    const idle = Number.parseFloat(m[1]);

    if (Number.isNaN(idle)) {
        return null;
    }

    return Math.round((100 - idle) * 10) / 10;
}

export function parseMemoryFreePct(memoryPressureOut: string): number | null {
    const m = memoryPressureOut.match(/System-wide memory free percentage:\s*(\d+)%/);

    if (!m) {
        return null;
    }

    const pct = Number.parseInt(m[1], 10);

    if (Number.isNaN(pct)) {
        return null;
    }

    return pct;
}

export function parseVmStat(vmStatOut: string, pageSize: number): { usedBytes: number } {
    const pages = (label: string): number => {
        const re = new RegExp(`${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+(\\d+)`);
        const m = vmStatOut.match(re);

        if (!m) {
            return 0;
        }

        return Number.parseInt(m[1], 10);
    };

    const active = pages("Pages active:");
    const wired = pages("Pages wired down:");
    const compressed = pages("Pages occupied by compressor:");
    return { usedBytes: (active + wired + compressed) * pageSize };
}

export function parseBattery(pmsetOut: string): { pct: number | null; state: string | null } {
    const m = pmsetOut.match(/(\d+)%;\s*([a-z ]+?)(?:;|\s+present)/i);

    if (!m) {
        return { pct: null, state: null };
    }

    const pct = Number.parseInt(m[1], 10);

    if (Number.isNaN(pct)) {
        return { pct: null, state: null };
    }

    return { pct, state: m[2].trim() };
}

export function parseDfRoot(dfOut: string): { freeBytes: number | null; totalBytes: number | null } {
    const lines = dfOut.trim().split("\n");

    if (lines.length < 2) {
        return { freeBytes: null, totalBytes: null };
    }

    const parts = lines[lines.length - 1].trim().split(/\s+/);

    if (parts.length < 4) {
        return { freeBytes: null, totalBytes: null };
    }

    const totalKb = Number.parseInt(parts[1], 10);
    const availKb = Number.parseInt(parts[3], 10);

    if (Number.isNaN(totalKb) || Number.isNaN(availKb)) {
        return { freeBytes: null, totalBytes: null };
    }

    return { freeBytes: availKb * 1024, totalBytes: totalKb * 1024 };
}

export function parseWifiSsid(out: string): string | null {
    const m = out.match(/Current Wi-Fi Network:\s*(.+)\s*$/m);

    if (!m) {
        return null;
    }

    return m[1].trim();
}

async function runShell(cmd: string[]): Promise<string | null> {
    try {
        const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
        const out = await new Response(proc.stdout).text();
        await proc.exited;

        if (proc.exitCode !== 0) {
            return null;
        }

        return out;
    } catch {
        return null;
    }
}

async function collectCpu(): Promise<number | null> {
    const out = await runShell(["top", "-l", "1", "-n", "0"]);

    if (out === null) {
        return null;
    }

    return parseCpuIdlePct(out);
}

async function collectMem(): Promise<{ used: number | null; total: number | null; freePct: number | null }> {
    const [vmStat, pageSizeOut, memSizeOut, memoryPressure] = await Promise.all([
        runShell(["vm_stat"]),
        runShell(["sysctl", "-n", "hw.pagesize"]),
        runShell(["sysctl", "-n", "hw.memsize"]),
        runShell(["memory_pressure"]),
    ]);

    const total = memSizeOut === null ? null : Number.parseInt(memSizeOut.trim(), 10);
    const pageSize = pageSizeOut === null ? null : Number.parseInt(pageSizeOut.trim(), 10);
    const freePct = memoryPressure === null ? null : parseMemoryFreePct(memoryPressure);

    if (vmStat === null || pageSize === null || Number.isNaN(pageSize)) {
        return { used: null, total: total !== null && !Number.isNaN(total) ? total : null, freePct };
    }

    const { usedBytes } = parseVmStat(vmStat, pageSize);
    return { used: usedBytes, total: total !== null && !Number.isNaN(total) ? total : null, freePct };
}

async function collectSwap(): Promise<{ used: number | null; total: number | null }> {
    const out = await runShell(["sysctl", "vm.swapusage"]);

    if (out === null) {
        return { used: null, total: null };
    }

    const swap = parseSwapUsage(out);
    return { used: swap.usedBytes, total: swap.totalBytes };
}

async function collectBattery(): Promise<{ pct: number | null; state: string | null }> {
    const out = await runShell(["pmset", "-g", "batt"]);

    if (out === null) {
        return { pct: null, state: null };
    }

    return parseBattery(out);
}

async function collectDisk(): Promise<{ free: number | null; total: number | null }> {
    const out = await runShell(["df", "-k", "/"]);

    if (out === null) {
        return { free: null, total: null };
    }

    const { freeBytes, totalBytes } = parseDfRoot(out);
    return { free: freeBytes, total: totalBytes };
}

let wifiInterface: string | null = null;

async function resolveWifiInterface(): Promise<string> {
    if (wifiInterface) {
        return wifiInterface;
    }

    const out = await runShell(["networksetup", "-listallhardwareports"]);

    if (out !== null) {
        const blocks = out.split(/\n\s*\n/);
        for (const block of blocks) {
            if (/Hardware Port:\s*Wi-Fi/i.test(block)) {
                const match = block.match(/Device:\s*(\S+)/);
                if (match) {
                    wifiInterface = match[1];
                    return wifiInterface;
                }
            }
        }
    }

    wifiInterface = "en0";
    return wifiInterface;
}

async function collectWifi(): Promise<string | null> {
    const iface = await resolveWifiInterface();
    const out = await runShell(["networksetup", "-getairportnetwork", iface]);

    if (out === null) {
        return null;
    }

    return parseWifiSsid(out);
}

async function collectTopProcesses(): Promise<TopProcess[]> {
    const all = await collectProcesses();
    return sortProcesses(all, "rss")
        .slice(0, 5)
        .map((r) => ({ pid: r.pid, name: r.name, rssBytes: r.rssBytes }));
}

export async function collectPulse(): Promise<PulseSnapshot> {
    const [cpu, mem, swap, battery, disk, wifi, topProcesses] = await Promise.all([
        collectCpu(),
        collectMem(),
        collectSwap(),
        collectBattery(),
        collectDisk(),
        collectWifi(),
        collectTopProcesses(),
    ]);

    return {
        cpuPct: cpu,
        memUsedBytes: mem.used,
        memTotalBytes: mem.total,
        memFreePct: mem.freePct,
        swapUsedBytes: swap.used,
        swapTotalBytes: swap.total,
        batteryPct: battery.pct,
        batteryState: battery.state,
        diskFreeBytes: disk.free,
        diskTotalBytes: disk.total,
        wifiSsid: wifi,
        publicIp: null,
        topProcesses,
        capturedAt: new Date().toISOString(),
    };
}

/**
 * Windows process and socket reads. Windows has no ps, lsof or pgrep: ONE PowerShell CIM query returns the whole
 * process table (or one process), and `netstat -ano` lists the TCP sockets with their owning pids. The parsers are
 * pure, so they are tested on captured output from any OS.
 */
import { SafeJSON } from "@genesiscz/utils/json";
import { captureSync } from "./ps";

export interface CimProcess {
    pid: number;
    ppid: number | null;
    /** The image name, `chrome.exe`. */
    name: string;
    command: string | null;
    executable: string | null;
    startMs: number | null;
    rssBytes: number | null;
    cpuTimeMs: number | null;
    threads: number | null;
    handles: number | null;
}

const CIM_FIELDS =
    "ProcessId,ParentProcessId,Name,CommandLine,ExecutablePath,CreationDate,WorkingSetSize,KernelModeTime,UserModeTime,ThreadCount,HandleCount";
/** PowerShell can take a few seconds to start on a cold machine. */
const POWERSHELL_TIMEOUT_MS = 15_000;

function cimQuery(pid?: number): string {
    const filter = pid === undefined ? "" : ` -Filter "ProcessId=${Math.trunc(pid)}"`;
    return `Get-CimInstance Win32_Process${filter} | Select-Object ${CIM_FIELDS} | ConvertTo-Json -Compress -Depth 2`;
}

function numberOrNull(value: unknown): number | null {
    const n = typeof value === "string" ? Number(value) : value;
    return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/** `CreationDate` as Windows PowerShell 5.1 (`/Date(1700000000000)/`) or PowerShell 7 (ISO 8601) serializes it. */
export function parseCimDate(value: unknown): number | null {
    if (typeof value !== "string") {
        return null;
    }

    const legacy = value.match(/Date\((-?\d+)/);

    if (legacy) {
        return Number(legacy[1]);
    }

    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
}

/** The `ConvertTo-Json` output of the CIM query: one object for one process, an array for several. */
export function parseCimProcessJson(stdout: string): CimProcess[] {
    let parsed: unknown;

    try {
        parsed = SafeJSON.parse(stdout, { strict: true });
    } catch {
        return [];
    }

    const list: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
    const processes: CimProcess[] = [];

    for (const raw of list) {
        if (typeof raw !== "object" || raw === null) {
            continue;
        }

        const row = raw as Record<string, unknown>;
        const pid = numberOrNull(row.ProcessId);

        if (pid === null) {
            continue;
        }

        const kernel = numberOrNull(row.KernelModeTime);
        const user = numberOrNull(row.UserModeTime);
        processes.push({
            pid,
            ppid: numberOrNull(row.ParentProcessId),
            name: typeof row.Name === "string" ? row.Name : "",
            command: typeof row.CommandLine === "string" ? row.CommandLine : null,
            executable: typeof row.ExecutablePath === "string" ? row.ExecutablePath : null,
            startMs: parseCimDate(row.CreationDate),
            rssBytes: numberOrNull(row.WorkingSetSize),
            // Kernel and user times count 100-nanosecond units.
            cpuTimeMs: kernel === null || user === null ? null : (kernel + user) / 10_000,
            threads: numberOrNull(row.ThreadCount),
            handles: numberOrNull(row.HandleCount),
        });
    }

    return processes;
}

/** Every process (or the one `pid`) through one PowerShell call; empty when PowerShell fails. */
export function listCimProcesses(pid?: number): CimProcess[] {
    const result = captureSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", cimQuery(pid)], {
        timeoutMs: POWERSHELL_TIMEOUT_MS,
    });
    return result.status === 0 ? parseCimProcessJson(result.stdout) : [];
}

export interface NetstatTcpRow {
    protocol: "TCP" | "UDP";
    localAddress: string;
    localPort: number;
    remoteAddress: string;
    remotePort: number;
    /** `LISTENING`, `ESTABLISHED`, … as netstat prints them; empty for UDP, which has no state column. */
    state: string;
    pid: number;
}

function splitEndpoint(text: string): { address: string; port: number } {
    const colon = text.lastIndexOf(":");
    const address = text.slice(0, colon).replace(/^\[|\]$/g, "");
    return { address, port: Number(text.slice(colon + 1)) };
}

/** The TCP and UDP lines of `netstat -ano` (IPv4 and IPv6). A UDP line has no state column. */
export function parseNetstatTcp(stdout: string): NetstatTcpRow[] {
    const rows: NetstatTcpRow[] = [];

    for (const line of stdout.split("\n")) {
        const parts = line.trim().split(/\s+/);
        const protocol = parts[0]?.toUpperCase();
        const udp = protocol === "UDP";

        if ((protocol !== "TCP" && !udp) || parts.length < (udp ? 4 : 5)) {
            continue;
        }

        const local = splitEndpoint(parts[1]);
        const remote = splitEndpoint(parts[2]);
        const pid = Number(parts[udp ? 3 : 4]);

        if (!Number.isFinite(local.port) || !Number.isFinite(pid)) {
            continue;
        }

        rows.push({
            protocol: udp ? "UDP" : "TCP",
            localAddress: local.address,
            localPort: local.port,
            remoteAddress: udp ? "" : remote.address,
            remotePort: udp ? 0 : remote.port,
            state: udp ? "" : parts[3],
            pid,
        });
    }

    return rows;
}

/** Every TCP and UDP socket with its owning pid, from one `netstat -ano`. */
export function listNetstatTcp(): NetstatTcpRow[] {
    return scanNetstatTcp() ?? [];
}

/** Null when the actual netstat scan failed or timed out, distinct from an empty successful scan. */
export function scanNetstatTcp(): NetstatTcpRow[] | null {
    const result = captureSync("netstat", ["-ano"], { timeoutMs: POWERSHELL_TIMEOUT_MS });
    return result.status === 0 && !result.timedOut ? parseNetstatTcp(result.stdout) : null;
}

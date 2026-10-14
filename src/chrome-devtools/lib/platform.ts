/**
 * Process inspection goes through the shared process layer. Tests attach a ProcessReader
 * to their ExecFn fixture; browser-control commands still use ExecFn directly.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { formatPsCpuTime, readProcessArgs } from "@genesiscz/utils/process/libproc-table";
import {
    findProcesses,
    listProcesses as processList,
    readExecutablePath,
    readProcess,
    readProcessUsages,
    runningNames,
} from "@genesiscz/utils/process/processes";
import { listListeningTcp } from "@genesiscz/utils/process/sockets";

const { log } = logger.scoped("chrome-devtools:platform");

export type Platform = "darwin" | "linux" | "win32";

export function currentPlatform(): Platform {
    if (process.platform === "darwin" || process.platform === "win32") {
        return process.platform;
    }

    return "linux";
}

export type ExecResult = { exitCode: number; stdout: string; stderr: string };
export type ExecFn = ((argv: string[]) => ExecResult) & { processReader?: (platform: Platform) => ProcessReader };

export interface ProcessReader {
    processes: () => ProcessEntry[];
    executable: (pid: number) => string | null;
    listeners: () => ListeningPort[];
    sample: (pid: number) => ProcessSample | null;
    runningNames: (names: string[]) => Set<string>;
    namedPids: (name: string) => number[];
}

const defaultProcessReader: ProcessReader = {
    processes: () =>
        processList().map((entry) => ({ pid: entry.pid, ppid: entry.ppid, command: entry.command ?? entry.name })),
    executable: readExecutablePath,
    listeners: () => listListeningTcp().map(({ pid, port }) => ({ pid, port })),
    sample: (pid) => {
        const entry = readProcess(pid);
        const usage = readProcessUsages([pid]).get(pid);
        if (!entry || !usage) {
            return null;
        }
        const elapsedMs = entry.startMs === null ? 0 : Math.max(0, Date.now() - entry.startMs);
        const seconds = Math.floor(elapsedMs / 1000);
        const days = Math.floor(seconds / 86400);
        const hours = Math.floor(seconds / 3600) % 24;
        const minutes = Math.floor(seconds / 60) % 60;
        const tail = `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
        const elapsed =
            days > 0
                ? `${days}-${String(hours).padStart(2, "0")}:${tail}`
                : hours > 0
                  ? `${String(hours).padStart(2, "0")}:${tail}`
                  : tail;
        return {
            pid,
            // Lifetime average: the kernel exposes cumulative time, not ps's decayed %cpu.
            cpuPercent: elapsedMs > 0 ? (100 * usage.cpuTimeMs) / elapsedMs : 0,
            rssKb: usage.rssBytes / 1024,
            cpuTime: formatPsCpuTime(usage.cpuTimeMs),
            elapsed,
            state: entry.state,
            command: entry.command ?? entry.name,
        };
    },
    runningNames,
    namedPids: (name) => findProcesses({ name }).map((entry) => entry.pid),
};

export function processReaderFor(exec: ExecFn, platform: Platform): ProcessReader {
    return exec.processReader?.(platform) ?? defaultProcessReader;
}

export function defaultExec(argv: string[]): ExecResult {
    const r = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });

    return {
        exitCode: r.exitCode ?? 1,
        stdout: typeof r.stdout === "string" ? r.stdout : new TextDecoder().decode(r.stdout),
        stderr: typeof r.stderr === "string" ? r.stderr : new TextDecoder().decode(r.stderr),
    };
}

// lint-rules-ignore: deliberate /tmp on POSIX — the capture contract (clears on reboot); Windows uses %TEMP%
const POSIX_TMP = "/tmp";

/** POSIX keeps the /tmp contract (clears on reboot — a privacy property for captures); Windows uses %TEMP%. */
export function tmpRoot(platform: Platform = currentPlatform()): string {
    return platform === "win32" ? tmpdir() : POSIX_TMP;
}

/** Default location for CLI artifacts (HARs, screenshots, logs). */
export function artifactPath(name: string, platform: Platform = currentPlatform()): string {
    return join(tmpRoot(platform), name);
}

export interface ProcessEntry {
    pid: number;
    ppid: number | null;
    command: string;
}

/** Parse `ps -axo pid=,ppid=,command=` output (darwin and linux procps agree on this shape). */
export function parsePsProcesses(stdout: string): ProcessEntry[] {
    const entries: ProcessEntry[] = [];
    for (const line of stdout.split("\n")) {
        const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
        if (m) {
            entries.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] });
        }
    }

    return entries;
}

interface CimProcess {
    ProcessId?: number;
    ParentProcessId?: number;
    CommandLine?: string | null;
    Name?: string;
}

/** Parse the ConvertTo-Json output of Get-CimInstance Win32_Process (object OR array). */
export function parseCimProcesses(stdout: string): ProcessEntry[] {
    let parsed: unknown;
    try {
        parsed = SafeJSON.parse(stdout, { strict: true });
    } catch (err) {
        log.debug({ err }, "CIM JSON parse failed");

        return [];
    }

    const list = Array.isArray(parsed) ? parsed : [parsed];
    const entries: ProcessEntry[] = [];
    for (const raw of list) {
        const p = raw as CimProcess;
        if (typeof p?.ProcessId !== "number") {
            continue;
        }

        entries.push({
            pid: p.ProcessId,
            ppid: typeof p.ParentProcessId === "number" ? p.ParentProcessId : null,
            command: p.CommandLine ?? p.Name ?? "",
        });
    }

    return entries;
}

/** Every process with its full command line and parent pid. ONE exec call on every platform. */
export function listProcesses(exec: ExecFn = defaultExec, platform: Platform = currentPlatform()): ProcessEntry[] {
    return processReaderFor(exec, platform).processes();
}

/**
 * One process's executable without its arguments: the full path on macOS, the task name on Linux (at most 15
 * characters), the image name on Windows. Null when the process is gone.
 */
export function processExecutable(
    pid: number,
    exec: ExecFn = defaultExec,
    platform: Platform = currentPlatform()
): string | null {
    return processReaderFor(exec, platform).executable(pid);
}

/** Structured argv only: never infer POSIX argument boundaries from space-joined ps output. */
export function processArguments(
    pid: number,
    exec: ExecFn = defaultExec,
    platform: Platform = currentPlatform()
): string[] | null {
    if (platform === "darwin") {
        return exec === defaultExec ? (readProcessArgs(pid)?.argv ?? null) : null;
    }

    if (platform === "linux") {
        const result = exec(["cat", `/proc/${pid}/cmdline`]);
        if (result.exitCode !== 0 || !result.stdout.endsWith("\0")) {
            return null;
        }

        return result.stdout.slice(0, -1).split("\0");
    }

    // Windows stores an encoded command line. Let its own argv decoder establish the boundaries.
    const script = [
        "$source = @'",
        "using System; using System.Runtime.InteropServices;",
        "public static class BrowserArgv {",
        '[DllImport("shell32.dll", CharSet=CharSet.Unicode)] static extern IntPtr CommandLineToArgvW(string s, out int n);',
        '[DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);',
        "public static string[] Parse(string s) { int n; IntPtr p = CommandLineToArgvW(s, out n);",
        'if (p == IntPtr.Zero) throw new Exception("argv unavailable");',
        "try { var a = new string[n]; for (int i=0; i<n; i++) a[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(p, i*IntPtr.Size)); return a; }",
        "finally { LocalFree(p); } } }",
        "'@",
        "Add-Type -TypeDefinition $source -ErrorAction Stop",
        `$line = (Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction Stop).CommandLine`,
        "if ([string]::IsNullOrEmpty($line)) { exit 1 }",
        "ConvertTo-Json -InputObject @([BrowserArgv]::Parse($line)) -Compress",
    ].join("\n");
    const result = exec(["powershell", "-NoProfile", "-Command", script]);
    if (result.exitCode !== 0) {
        return null;
    }

    try {
        const args: unknown = SafeJSON.parse(result.stdout, { strict: true });
        return Array.isArray(args) && args.every((arg) => typeof arg === "string") ? args : null;
    } catch (err) {
        log.debug({ err, pid }, "process argv JSON parse failed");
        return null;
    }
}

export interface ListeningPort {
    port: number;
    pid: number | null;
}

/** Parse `lsof -nP -iTCP -sTCP:LISTEN` (POSIX). */
export function parseLsofListeners(stdout: string): ListeningPort[] {
    const out: ListeningPort[] = [];
    for (const line of stdout.split("\n")) {
        const m = line.match(/^\S+\s+(\d+)\s+.*:(\d+)\s+\(LISTEN\)/);
        if (m) {
            out.push({ port: Number(m[2]), pid: Number(m[1]) });
        }
    }

    return out;
}

/** Parse `netstat -ano -p TCP` LISTENING lines (win32). */
export function parseNetstatListeners(stdout: string): ListeningPort[] {
    const out: ListeningPort[] = [];
    for (const line of stdout.split("\n")) {
        const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i);
        if (m) {
            out.push({ port: Number(m[1]), pid: Number(m[2]) });
        }
    }

    return out;
}

/** Every listening TCP port with its owning pid. */
export function listListeningTcpPorts(
    exec: ExecFn = defaultExec,
    platform: Platform = currentPlatform()
): ListeningPort[] {
    return processReaderFor(exec, platform).listeners();
}

/**
 * Graceful terminate, portable. POSIX: SIGTERM (Chrome saves session state).
 * win32: `taskkill /PID` without /F posts WM_CLOSE-style termination.
 */
export function terminatePid(
    pid: number,
    exec: ExecFn = defaultExec,
    platform: Platform = currentPlatform()
): ExecResult {
    if (platform === "win32") {
        return exec(["taskkill", "/PID", String(pid)]);
    }

    return exec(["kill", String(pid)]);
}

/** SIGPIPE does not exist on win32; registering the guard there is a no-op. */
export function ignoreSigpipe(platform: Platform = currentPlatform()): void {
    if (platform !== "win32") {
        process.on("SIGPIPE", () => {});
    }

    const swallow = (err: { code?: string }) => {
        if (err.code === "EPIPE") {
            return;
        }

        throw err;
    };
    process.stdout.on("error", swallow);
    process.stderr.on("error", swallow);
}

export interface ProcessSample {
    pid: number;
    /** null when the platform cannot cheaply report an instantaneous %CPU (win32). */
    cpuPercent: number | null;
    rssKb: number;
    cpuTime: string;
    elapsed: string;
    state: string;
    command: string;
}

/** Parse one `ps -p <pid> -o pcpu=,rss=,time=,etime=,stat=,command=` line. */
export function parsePsSample(pid: number, line: string): ProcessSample | null {
    const m = line.match(/^\s*([\d.]+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/);
    if (!m) {
        return null;
    }

    return {
        pid,
        cpuPercent: Number(m[1]),
        rssKb: Number(m[2]),
        cpuTime: m[3],
        elapsed: m[4],
        state: m[5],
        command: m[6],
    };
}

interface CimSample {
    WorkingSetSize?: number;
    KernelModeTime?: number;
    UserModeTime?: number;
    CommandLine?: string | null;
    Name?: string;
    CreationDate?: string;
}

/** Parse the CIM JSON for one process into a sample (cpu time from 100ns kernel+user ticks). */
export function parseCimSample(pid: number, stdout: string): ProcessSample | null {
    let parsed: unknown;
    try {
        parsed = SafeJSON.parse(stdout, { strict: true });
    } catch (err) {
        log.debug({ err, pid, stdout: stdout.slice(0, 200) }, "CIM sample JSON parse failed");

        return null;
    }

    const p = (Array.isArray(parsed) ? parsed[0] : parsed) as CimSample | undefined;
    if (!p) {
        return null;
    }

    const cpuSeconds = ((p.KernelModeTime ?? 0) + (p.UserModeTime ?? 0)) / 10_000_000;
    const hh = Math.floor(cpuSeconds / 3600);
    const mm = Math.floor((cpuSeconds % 3600) / 60);
    const ss = (cpuSeconds % 60).toFixed(2).padStart(5, "0");
    const cpuTime = hh > 0 ? `${hh}:${String(mm).padStart(2, "0")}:${ss}` : `${mm}:${ss}`;

    return {
        pid,
        cpuPercent: null,
        rssKb: Math.round((p.WorkingSetSize ?? 0) / 1024),
        cpuTime,
        elapsed: "—",
        state: "—",
        command: p.CommandLine ?? p.Name ?? "",
    };
}

export function sampleProcess(
    pid: number,
    exec: ExecFn = defaultExec,
    platform: Platform = currentPlatform()
): ProcessSample | null {
    return processReaderFor(exec, platform).sample(pid);
}

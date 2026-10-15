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
    readProcessesWithUsage,
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
        // One snapshot of the one process: on Windows each separate read is a PowerShell start, two of them over the
        // whole CIM table.
        const entry = readProcessesWithUsage([pid], { cpuPercent: true })[0];
        const usage = entry?.usage;
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
            // `ps`'s %cpu: recent usage, so the doctor's "recorder is hot" check sees a recorder that is busy now.
            cpuPercent: entry.cpuPercent ?? 0,
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

export function sampleProcess(
    pid: number,
    exec: ExecFn = defaultExec,
    platform: Platform = currentPlatform()
): ProcessSample | null {
    return processReaderFor(exec, platform).sample(pid);
}

/**
 * OS primitives behind the tool, one place per platform:
 *
 * - darwin/linux share the POSIX path (`ps`, `lsof`, `pgrep`); they differ only
 *   in browser naming and how a browser is launched/quit (resolve-attach.ts).
 * - win32 goes through PowerShell CIM (one call returns pid/ppid/commandline),
 *   `netstat -ano` and `tasklist`.
 *
 * Every function takes an injectable ExecFn and, where behavior differs, an
 * explicit `platform` — the pure parsers are exported so each platform's shape
 * is unit-tested without that OS.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

const { log } = logger.scoped("chrome-devtools:platform");

export type Platform = "darwin" | "linux" | "win32";

export function currentPlatform(): Platform {
    if (process.platform === "darwin" || process.platform === "win32") {
        return process.platform;
    }

    return "linux";
}

export type ExecResult = { exitCode: number; stdout: string; stderr: string };
export type ExecFn = (argv: string[]) => ExecResult;

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

const CIM_PROCESS_QUERY =
    "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine,Name | ConvertTo-Json -Depth 2";

/** Every process with its full command line and parent pid. ONE exec call on every platform. */
export function listProcesses(exec: ExecFn = defaultExec, platform: Platform = currentPlatform()): ProcessEntry[] {
    if (platform === "win32") {
        const r = exec(["powershell", "-NoProfile", "-Command", CIM_PROCESS_QUERY]);

        return r.exitCode === 0 ? parseCimProcesses(r.stdout) : [];
    }

    const r = exec(["ps", "-axo", "pid=,ppid=,command="]);

    return r.exitCode === 0 ? parsePsProcesses(r.stdout) : [];
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
    if (platform === "win32") {
        const r = exec(["netstat", "-ano", "-p", "TCP"]);

        return r.exitCode === 0 ? parseNetstatListeners(r.stdout) : [];
    }

    const r = exec(["lsof", "-nP", "-iTCP", "-sTCP:LISTEN"]);

    return r.exitCode === 0 ? parseLsofListeners(r.stdout) : [];
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
    if (platform === "win32") {
        const r = exec([
            "powershell",
            "-NoProfile",
            "-Command",
            `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object WorkingSetSize,KernelModeTime,UserModeTime,CommandLine,Name | ConvertTo-Json`,
        ]);

        return r.exitCode === 0 ? parseCimSample(pid, r.stdout) : null;
    }

    const r = exec(["ps", "-p", String(pid), "-o", "pcpu=,rss=,time=,etime=,stat=,command="]);
    if (r.exitCode !== 0) {
        return null;
    }

    return parsePsSample(pid, r.stdout.trim().split("\n")[0] ?? "");
}

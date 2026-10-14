import { SafeJSON } from "@genesiscz/utils/json";
import type { ExecFn, ListeningPort, Platform, ProcessEntry, ProcessReader, ProcessSample } from "../platform";

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
function parseNetstatListeners(stdout: string): ListeningPort[] {
    const out: ListeningPort[] = [];
    for (const line of stdout.split("\n")) {
        const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i);
        if (m) {
            out.push({ port: Number(m[1]), pid: Number(m[2]) });
        }
    }

    return out;
}

/** Parse `ps -axo pid=,ppid=,command=` output (darwin and linux procps agree on this shape). */
function parsePsProcesses(stdout: string): ProcessEntry[] {
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
function parseCimProcesses(stdout: string): ProcessEntry[] {
    let parsed: unknown;
    try {
        parsed = SafeJSON.parse(stdout, { strict: true });
    } catch {
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

/** Parse one `ps -p <pid> -o pcpu=,rss=,time=,etime=,stat=,command=` line. */
function parsePsSample(pid: number, line: string): ProcessSample | null {
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
function parseCimSample(pid: number, stdout: string): ProcessSample | null {
    let parsed: unknown;
    try {
        parsed = SafeJSON.parse(stdout, { strict: true });
    } catch {
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

/** Parse `tasklist /FO CSV /NH` image names. */
function parseTasklistImages(stdout: string): Set<string> {
    const names = new Set<string>();
    for (const line of stdout.split("\n")) {
        const m = line.match(/^"([^"]+)"/);
        if (m) {
            names.add(m[1].toLowerCase());
        }
    }

    return names;
}

/** Adapt existing command fixtures to the injectable layer reader without starting real processes. */
export function processFixture<T extends ExecFn>(exec: T): T {
    const read = (platform: Platform): ProcessReader => ({
        processes: () => {
            const result =
                platform === "win32"
                    ? exec([
                          "powershell",
                          "-NoProfile",
                          "-Command",
                          "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine,Name | ConvertTo-Json -Depth 2",
                      ])
                    : exec(["ps", "-axo", "pid=,ppid=,command="]);
            return result.exitCode === 0
                ? platform === "win32"
                    ? parseCimProcesses(result.stdout)
                    : parsePsProcesses(result.stdout)
                : [];
        },
        executable: (pid) => {
            const result =
                platform === "win32"
                    ? exec([
                          "powershell",
                          "-NoProfile",
                          "-Command",
                          `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").Name`,
                      ])
                    : exec(["ps", "-o", "comm=", "-p", String(pid)]);
            return result.exitCode === 0 ? result.stdout.trim() || null : null;
        },
        listeners: () => {
            const result =
                platform === "win32"
                    ? exec(["netstat", "-ano", "-p", "TCP"])
                    : exec(["lsof", "-nP", "-iTCP", "-sTCP:LISTEN"]);
            return result.exitCode === 0
                ? platform === "win32"
                    ? parseNetstatListeners(result.stdout)
                    : parseLsofListeners(result.stdout)
                : [];
        },
        sample: (pid) => {
            const result =
                platform === "win32"
                    ? exec([
                          "powershell",
                          "-NoProfile",
                          "-Command",
                          'Get-CimInstance Win32_Process -Filter "ProcessId=' +
                              pid +
                              '" | Select-Object WorkingSetSize,KernelModeTime,UserModeTime,CommandLine,Name | ConvertTo-Json',
                      ])
                    : exec(["ps", "-p", String(pid), "-o", "pcpu=,rss=,time=,etime=,stat=,command="]);
            return result.exitCode === 0
                ? platform === "win32"
                    ? parseCimSample(pid, result.stdout)
                    : parsePsSample(pid, result.stdout)
                : null;
        },
        runningNames: (names) => {
            if (platform === "win32") {
                const result = exec([
                    "tasklist",
                    "/FO",
                    "CSV",
                    "/NH",
                    ...(names.length === 1 ? ["/FI", `IMAGENAME eq ${names[0]}`] : []),
                ]);
                const images = result.exitCode === 0 ? parseTasklistImages(result.stdout) : new Set<string>();
                return new Set(names.filter((name) => images.has(name)));
            }
            return new Set(names.filter((name) => exec(["pgrep", "-x", name]).exitCode === 0));
        },
        namedPids: (name) => exec(["pgrep", "-x", name]).stdout.trim().split("\n").filter(Boolean).map(Number),
    });
    return Object.assign(exec, { processReader: read });
}

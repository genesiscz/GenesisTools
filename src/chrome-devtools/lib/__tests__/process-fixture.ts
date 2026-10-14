import {
    type ExecFn,
    type Platform,
    type ProcessReader,
    parseCimProcesses,
    parseCimSample,
    parseLsofListeners,
    parseNetstatListeners,
    parsePsProcesses,
    parsePsSample,
} from "../platform";
import { parseTasklistImages } from "../resolve-attach";

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

import { flushProfilerFile, profiler } from "@genesiscz/utils/profile";
import { currentTraceId } from "@genesiscz/utils/trace";

/** The command a run executed, as `agents changes`: names only, never argument values (set by `runTool`). */
let runLabel: string | null = null;

export function setRunLabel(label: string): void {
    runLabel = label;
}

/**
 * One `[profile:cli]` line per command run, written at exit: wall time since the process started (Bun
 * startup and imports included, which is what a caller waits for), CPU time, peak memory, and
 * `caller=app` when GenesisTools.app started it (its trace id is set). `tools hub dev monitor` reports
 * the slow ones, so a command that costs seconds is seen without a timer inside it. A script that does not go
 * through `runTool` (a daemon tick) calls it itself with its name. A small module on purpose: a daemon tick
 * imports it without the CLI helpers.
 */
export function recordRunOnExit(tool: string): void {
    const cli = profiler.scope("cli");

    if (!cli.enabled) {
        return;
    }

    process.once("exit", (code) => {
        const cpu = process.cpuUsage();
        const cpuMs = Math.round((cpu.user + cpu.system) / 1000);
        const rssMb = Math.round(process.resourceUsage().maxRSS / 1024);
        const caller = currentTraceId() ? "app" : "shell";
        cli.record(runLabel ?? tool, performance.now(), `exit=${code} cpu=${cpuMs}ms rss=${rssMb}MB caller=${caller}`);
        // The profiler's own exit flush may already have run.
        flushProfilerFile();
    });
}

import { existsSync, statfsSync } from "node:fs";
import { homedir } from "node:os";
import { basename } from "node:path";
// lint-rules-ignore: the triage report asks the resident hub server for its health, and the hub's socket client is the one door to that server
import { askHubServer } from "@app/hub/server/client";
import { runtimeLoad, runtimeMemory, runtimeProcesses } from "@genesiscz/utils/diagnostics/runtime";
import { readLastLines } from "@genesiscz/utils/fs/read-lines";
import { logger } from "@genesiscz/utils/logger";
import { captureSync } from "@genesiscz/utils/process/capture";
import { genesisToolsDir } from "@genesiscz/utils/storage/root";
import { crashReports } from "./crash-reports";
import { type EnvironmentReport, environmentMarkdown, gatherEnvironment } from "./environment";
import { loadFailures } from "./failures";

/** One part of the triage: its value, or why it could not be read. A part that fails never fails the report. */
export type TriagePart<T> = { ok: true; value: T } | { ok: false; error: string };

export interface TriageProcess {
    pid: number;
    /** The executable's name, and for a runtime (bun, node) the script it runs: never the whole command line. */
    name: string;
    cpuPercent: number | null;
    rssMb: number;
}

/** A failed run, or (kind `deadline`) a child command of a run that outlived its Executor bound. */
export interface TriageFailure {
    at: string;
    command: string;
    exit: number | null;
    message: string | null;
    /** Set for a `deadline` record only: it has no exit, the run went on. */
    kind?: "deadline";
}

export interface TriageReport {
    at: string;
    /** How long the whole gather took. */
    tookMs: number;
    environment: TriagePart<EnvironmentReport>;
    load: TriagePart<{ one: number; five: number; fifteen: number; cores: number }>;
    memory: TriagePart<{ totalGb: number; freeGb: number; pressure: string | null; swapUsedGb: number | null }>;
    processes: TriagePart<{ count: number; topCpu: TriageProcess[]; topMemory: TriageProcess[] }>;
    hubServer: TriagePart<
        | { state: "answers"; pid: number; upMin: number; calls: number; errors: number; footprintMb: number }
        | { state: "busy" | "absent" }
    >;
    faces: TriagePart<Array<{ face: string; pid: number; startedAt: string | null }>>;
    failures: TriagePart<Array<TriageFailure>>;
    slowCalls: TriagePart<string[]>;
    crashes: TriagePart<Array<{ process: string; at: string; path: string }>>;
    disk: TriagePart<{ freeGb: number; totalGb: number }>;
}

/** Where each part comes from; the real ones read the Mac, a test hands in fixed values. */
export interface TriageSources {
    now: () => Date;
    environment: () => EnvironmentReport;
    load: () => { one: number; five: number; fifteen: number; cores: number };
    memory: () => { totalGb: number; freeGb: number; pressure: string | null; swapUsedGb: number | null };
    processes: () => Array<{
        pid: number;
        name: string;
        command: string | null;
        cpuPercent: number | null;
        rssBytes: number;
        startMs: number | null;
    }>;
    hubServer: () => Promise<TriageReport["hubServer"] extends TriagePart<infer T> ? T : never>;
    failures: (since: Date, until: Date) => Array<TriageFailure>;
    perfLogTail: () => string[];
    crashes: (since: Date, until: Date) => Array<{ process: string; at: string; path: string }>;
    disk: () => { freeGb: number; totalGb: number };
}

const TOP = 5;
const FAILURE_WINDOW_MS = 30 * 60_000;
const CRASH_WINDOW_MS = 24 * 3_600_000;
/** The hub server answers a health ask in milliseconds; past this it is busy, and the report says so. */
const HUB_SERVER_ASK_MS = 1_500;
const SLOW_CALL = /via=(server|process)-timeout|TIMEOUT after|main-stall|wedge|hang |layout\.loop| failed/;
const GB = 1024 ** 3;

function part<T>(name: string, read: () => T): TriagePart<T> {
    try {
        return { ok: true, value: read() };
    } catch (error) {
        logger.debug({ error, part: name }, "triage: a part could not be read");
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}

/** `bun` or `node` with the script it runs ("bun hub/index.ts"); any other process by its executable's name. */
export function processLabel(name: string, command: string | null): string {
    if (!command) {
        return name;
    }

    const words = command.split(/\s+/);
    const executable = basename(words[0] ?? name);
    if (!/^(bun|node|gt-[a-z-]+|python3?|ruby)$/.test(executable)) {
        return executable || name;
    }

    const script = words
        .slice(1)
        .find((word, index, rest) => !word.startsWith("-") && !rest[index - 1]?.startsWith("--preload"));
    if (!script) {
        return executable;
    }

    return `${executable} ${script.split("/").slice(-2).join("/")}`;
}

const FACE = /MacOS\/GenesisTools (--[a-z-]+)/;

/**
 * What an agent needs to judge a failure on this Mac, beside the build facts of `gatherEnvironment`: how busy the Mac
 * is, what uses its CPU and memory, whether the hub server answers, which app faces run, what failed, timed out or
 * crashed just before. Reads only. Every part has its own deadline and its own error, so the report comes back on a
 * Mac that is too busy to answer one of them: a busy Mac is when it is asked for.
 */
export async function gatherTriage(sources: TriageSources = realTriageSources()): Promise<TriageReport> {
    const started = performance.now();
    const now = sources.now();
    const hubServer = sources.hubServer().then(
        (value): TriageReport["hubServer"] => ({ ok: true, value }),
        (error: unknown): TriageReport["hubServer"] => ({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
        })
    );
    const processes = part("processes", () => {
        const rows = sources.processes();
        const row = (entry: (typeof rows)[number]): TriageProcess => ({
            pid: entry.pid,
            name: processLabel(entry.name, entry.command),
            cpuPercent: entry.cpuPercent,
            rssMb: Math.round(entry.rssBytes / 1024 / 1024),
        });
        const faces = rows.flatMap((entry) => {
            const face = entry.command ? FACE.exec(entry.command)?.[1] : undefined;
            return face
                ? [{ face, pid: entry.pid, startedAt: entry.startMs ? new Date(entry.startMs).toISOString() : null }]
                : [];
        });
        return {
            faces,
            count: rows.length,
            topCpu: [...rows]
                .sort((a, b) => (b.cpuPercent ?? 0) - (a.cpuPercent ?? 0))
                .slice(0, TOP)
                .map(row),
            topMemory: [...rows]
                .sort((a, b) => b.rssBytes - a.rssBytes)
                .slice(0, TOP)
                .map(row),
        };
    });

    const report: Omit<TriageReport, "tookMs" | "hubServer"> = {
        at: now.toISOString(),
        environment: part("environment", sources.environment),
        load: part("load", sources.load),
        memory: part("memory", sources.memory),
        processes: processes.ok
            ? {
                  ok: true,
                  value: {
                      count: processes.value.count,
                      topCpu: processes.value.topCpu,
                      topMemory: processes.value.topMemory,
                  },
              }
            : processes,
        faces: processes.ok ? { ok: true, value: processes.value.faces } : processes,
        failures: part("failures", () =>
            sources.failures(new Date(now.getTime() - FAILURE_WINDOW_MS), now).slice(0, TOP)
        ),
        slowCalls: part("slowCalls", () =>
            sources
                .perfLogTail()
                .filter((line) => SLOW_CALL.test(line))
                .slice(-8)
                // A stall line repeats the load history after "recent="; the Top CPU bullet has the present one.
                .map((line) => line.split(" recent=[")[0])
        ),
        crashes: part("crashes", () => sources.crashes(new Date(now.getTime() - CRASH_WINDOW_MS), now).slice(0, TOP)),
        disk: part("disk", sources.disk),
    };

    return { ...report, hubServer: await hubServer, tookMs: Math.round(performance.now() - started) };
}

function clock(iso: string, timeZone?: string): string {
    return new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(
        new Date(iso)
    );
}

/** "State of this Mac": one bullet per part, a part that could not be read named with its reason. */
export function triageMarkdown(report: TriageReport): string {
    const zone = report.environment.ok ? report.environment.value.timeZone : undefined;
    const lines: string[] = [];
    const failed = (name: string, error: string) => lines.push(`- **${name}:** not read (${error})`);
    const proc = (entry: TriageProcess, by: "cpu" | "memory") =>
        `${entry.name} ${by === "cpu" ? `${Math.round(entry.cpuPercent ?? 0)}%` : `${entry.rssMb} MB`} (pid ${entry.pid})`;

    if (report.load.ok) {
        const { one, five, fifteen, cores } = report.load.value;
        const verdict = one > cores * 2 ? ", overloaded" : one > cores ? ", busy" : "";
        lines.push(
            `- **Load:** ${one.toFixed(1)} ${five.toFixed(1)} ${fifteen.toFixed(1)} on ${cores} cores${verdict}`
        );
    } else {
        failed("Load", report.load.error);
    }

    if (report.memory.ok) {
        const memory = report.memory.value;
        const extras = [
            memory.pressure ? `pressure ${memory.pressure}` : null,
            memory.swapUsedGb !== null ? `swap ${memory.swapUsedGb.toFixed(1)} GB used` : null,
        ].filter(Boolean);
        // macOS keeps almost no page unused, so the pressure and the swap say more than this number.
        lines.push(
            `- **Memory:** ${memory.freeGb.toFixed(1)} GB unused of ${memory.totalGb.toFixed(0)} GB${extras.length > 0 ? `, ${extras.join(", ")}` : ""}`
        );
    } else {
        failed("Memory", report.memory.error);
    }

    if (report.processes.ok) {
        lines.push(`- **Top CPU:** ${report.processes.value.topCpu.map((entry) => proc(entry, "cpu")).join(", ")}`);
        lines.push(
            `- **Top memory:** ${report.processes.value.topMemory.map((entry) => proc(entry, "memory")).join(", ")}`
        );
    } else {
        failed("Processes", report.processes.error);
    }

    if (report.hubServer.ok) {
        const server = report.hubServer.value;
        lines.push(
            server.state === "answers"
                ? `- **Hub server:** pid ${server.pid}, up ${server.upMin} min, ${server.calls} calls, ${server.errors} errors, ${server.footprintMb} MB`
                : server.state === "busy"
                  ? `- **Hub server:** running, but it did not answer in ${HUB_SERVER_ASK_MS} ms`
                  : "- **Hub server:** not running"
        );
    } else {
        failed("Hub server", report.hubServer.error);
    }

    if (report.faces.ok) {
        const faces = report.faces.value.map(
            (face) => `${face.face} pid ${face.pid}${face.startedAt ? ` (since ${clock(face.startedAt, zone)})` : ""}`
        );
        lines.push(`- **App faces:** ${faces.length > 0 ? faces.join(", ") : "none running"}`);
    }

    if (report.disk.ok) {
        lines.push(
            `- **Disk:** ${report.disk.value.freeGb.toFixed(0)} GB free of ${report.disk.value.totalGb.toFixed(0)} GB`
        );
    } else {
        failed("Disk", report.disk.error);
    }

    if (report.failures.ok && report.failures.value.length > 0) {
        lines.push(`- **Failed commands, last 30 min:**`);
        for (const failure of report.failures.value) {
            lines.push(
                `    - ${clock(failure.at, zone)} \`tools ${failure.command}\` ${failure.kind === "deadline" ? "command deadline" : `exit ${failure.exit ?? "?"}`}${failure.message ? `: ${failure.message.slice(0, 160)}` : ""}`
            );
        }
    } else if (!report.failures.ok) {
        failed("Failed commands", report.failures.error);
    }

    if (report.slowCalls.ok && report.slowCalls.value.length > 0) {
        lines.push("- **Slow or lost calls (the end of app-perf.log):**");
        for (const line of report.slowCalls.value) {
            lines.push(`    - \`${line.slice(0, 220).replaceAll("`", "'")}\``);
        }
    } else if (!report.slowCalls.ok) {
        failed("Slow calls", report.slowCalls.error);
    }

    if (report.crashes.ok && report.crashes.value.length > 0) {
        lines.push(
            `- **Crash reports, last 24 h:** ${report.crashes.value.map((crash) => `${crash.process} at ${clock(crash.at, zone)} (\`${crash.path}\`)`).join(", ")}`
        );
    } else if (!report.crashes.ok) {
        failed("Crash reports", report.crashes.error);
    }

    return lines.join("\n");
}

/** The environment section, then the state of the Mac under its own heading. */
export function triageDocument(report: TriageReport): string {
    const environment = report.environment.ok
        ? environmentMarkdown(report.environment.value)
        : `- **Environment:** not read (${report.environment.error})`;
    return `${environment}\n\n#### State of this Mac at ${clock(report.at, report.environment.ok ? report.environment.value.timeZone : undefined)} (gathered in ${report.tookMs} ms)\n\n${triageMarkdown(report)}`;
}

/** `sysctl -n` for several names in one process; a name the kernel does not have reads as an empty line. */
function sysctl(names: string[]): string[] {
    const result = captureSync("sysctl", ["-n", ...names], { timeoutMs: 1_500 });
    return result.stdout.split("\n");
}

const PRESSURE: Record<string, string> = { "1": "normal", "2": "warning", "4": "critical" };

export function realTriageSources(): TriageSources {
    return {
        now: () => new Date(),
        environment: () => gatherEnvironment(),
        load: runtimeLoad,
        memory: () => {
            let pressure: string | null = null;
            let swapUsedGb: number | null = null;
            if (process.platform === "darwin") {
                const [level, swap] = sysctl(["kern.memorystatus_vm_pressure_level", "vm.swapusage"]);
                pressure = PRESSURE[level?.trim() ?? ""] ?? null;
                const used = /used = ([\d.]+)M/.exec(swap ?? "");
                swapUsedGb = used ? Number(used[1]) / 1024 : null;
            }

            return { ...runtimeMemory(), pressure, swapUsedGb };
        },
        processes: runtimeProcesses,
        hubServer: async () => {
            const probe = await askHubServer("health", { timeoutMs: HUB_SERVER_ASK_MS });
            if (probe.state !== "answers") {
                return { state: probe.state };
            }

            const health = (probe.reply.health ?? probe.reply) as Record<string, unknown>;
            const startedAt = typeof health.startedAt === "string" ? Date.parse(health.startedAt) : Number.NaN;
            return {
                state: "answers",
                pid: Number(health.pid),
                upMin: Number.isFinite(startedAt) ? Math.round((Date.now() - startedAt) / 60_000) : 0,
                calls: Number(health.calls ?? 0),
                errors: Number(health.errors ?? 0),
                footprintMb: Math.round(Number(health.footprintBytes ?? 0) / 1024 / 1024),
            };
        },
        failures: (from, to) =>
            loadFailures({ window: { from, to }, limit: TOP })
                .map((failure) => ({
                    at: failure.at,
                    // The command path starts with its tool ("task run").
                    command: failure.command ?? failure.tool,
                    exit: failure.exitCode,
                    message: failure.message,
                    // Kept on purpose: a child killed at its deadline just before is what a bug report needs.
                    ...(failure.kind === "deadline" ? { kind: "deadline" as const } : {}),
                }))
                .reverse(),
        perfLogTail: () => {
            const file = genesisToolsDir("logs", "app-perf.log");
            return existsSync(file) ? readLastLines(file, { maxBytes: 256 * 1024 }).lines : [];
        },
        crashes: (from, to) => crashReports({ from, to }),
        disk: () => {
            const stat = statfsSync(homedir());
            return { freeGb: (stat.bavail * stat.bsize) / GB, totalGb: (stat.blocks * stat.bsize) / GB };
        },
    };
}

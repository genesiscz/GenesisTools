import { out } from "@app/logger";
import {
    createBoxTable,
    formatDotStatus,
    renderCliHeader,
    renderCliKeyRow,
    renderCliSection,
    truncateDisplay,
} from "@app/utils/table";
import pc from "picocolors";
import type { KillResult, PortSnapshot, ProcessSnapshot } from "./types";

/** @deprecated Prefer `renderCliHeader` from `@app/utils/table` — kept for callers. */
export const renderHeader = renderCliHeader;

function formatFramework(framework: string | null): string {
    if (!framework) {
        return pc.dim("—");
    }

    const colors: Record<string, (value: string) => string> = {
        "Next.js": pc.white,
        Vite: pc.yellow,
        React: pc.cyan,
        Vue: pc.green,
        Angular: pc.red,
        Express: pc.gray,
        Fastify: pc.white,
        NestJS: pc.red,
        Nuxt: pc.green,
        Remix: pc.blue,
        Astro: pc.magenta,
        Django: pc.green,
        Flask: pc.white,
        FastAPI: pc.cyan,
        Rails: pc.red,
        Go: pc.cyan,
        Rust: pc.yellow,
        Python: pc.yellow,
        Docker: pc.blue,
    };

    return (colors[framework] ?? pc.white)(framework);
}

function formatStatus(status: PortSnapshot["status"] | ProcessSnapshot["status"]): string {
    switch (status) {
        case "healthy":
            return formatDotStatus("ok", "healthy");
        case "orphaned":
            return formatDotStatus("warn", "orphaned");
        case "zombie":
            return formatDotStatus("err", "zombie");
        default:
            return formatDotStatus("dim", "unknown");
    }
}

function formatCpu(cpu: number): string {
    const value = cpu.toFixed(1);

    if (cpu >= 25) {
        return pc.red(value);
    }

    if (cpu >= 5) {
        return pc.yellow(value);
    }

    return pc.green(value);
}

export function displayPortTable(ports: PortSnapshot[], filtered: boolean): void {
    renderHeader("Port Overview", "listen to your ports");

    if (ports.length === 0) {
        out.println(pc.dim("  No matching listening ports found.\n"));
        out.println(pc.dim(`  Try ${pc.cyan("tools port --all")} to include system services.\n`));
        return;
    }

    const table = createBoxTable(["PORT", "PROCESS", "PID", "PROJECT", "FRAMEWORK", "UPTIME", "STATUS"]);

    for (const portInfo of ports) {
        table.push([
            pc.white(pc.bold(`:${portInfo.port}`)),
            pc.white(portInfo.processName),
            pc.dim(String(portInfo.pid)),
            portInfo.projectName ? pc.blue(truncateDisplay(portInfo.projectName, 20)) : pc.dim("—"),
            formatFramework(portInfo.framework),
            portInfo.uptime ? pc.yellow(portInfo.uptime) : pc.dim("—"),
            formatStatus(portInfo.status),
        ]);
    }

    out.println(table.toString());
    out.println();
    const filterHint = filtered ? `${pc.dim("  ·  ")}${pc.cyan("--all")}${pc.dim(" to show everything")}` : "";
    out.println(
        `${pc.dim(`  ${ports.length} port${ports.length === 1 ? "" : "s"} active  ·  `)}${pc.dim("Run ")}${pc.cyan(
            "tools port <number>"
        )}${pc.dim(" for details")}${filterHint}`
    );
    out.println();
}

export function displayPortDetail(port: number, snapshots: PortSnapshot[], gitBranch: string | null): void {
    renderHeader(`Port :${port}`, "inspect and manage processes");

    if (snapshots.length === 0) {
        out.println(pc.red("  No process found on that port.\n"));
        return;
    }

    const table = createBoxTable(["PID", "PROCESS", "USER", "STATE", "PROJECT", "FRAMEWORK", "UPTIME", "STATUS"]);

    for (const snapshot of snapshots) {
        table.push([
            pc.white(pc.bold(String(snapshot.pid))),
            pc.white(snapshot.processName),
            pc.dim(snapshot.user),
            snapshot.state === "LISTEN" ? pc.green(snapshot.state) : pc.yellow(snapshot.state),
            snapshot.projectName ? pc.blue(truncateDisplay(snapshot.projectName, 18)) : pc.dim("—"),
            formatFramework(snapshot.framework),
            snapshot.uptime ? pc.yellow(snapshot.uptime) : pc.dim("—"),
            formatStatus(snapshot.status),
        ]);
    }

    out.println(table.toString());
    out.println();

    const primary = snapshots[0];
    renderCliSection("Location");
    renderCliKeyRow("Directory", primary.cwd ? pc.blue(primary.cwd) : pc.dim("—"), 14);
    renderCliKeyRow("Command", pc.white(truncateDisplay(primary.command, 80)), 14);
    renderCliKeyRow("Started", primary.startTime ? pc.dim(primary.startTime.toLocaleString()) : pc.dim("—"), 14);
    renderCliKeyRow("Memory", primary.memory ? pc.green(primary.memory) : pc.dim("—"), 14);
    renderCliKeyRow("Git Branch", gitBranch ? pc.magenta(gitBranch) : pc.dim("—"), 14);
    out.println();
    out.println(
        `${pc.dim("  Tip: use ")}${pc.cyan("tools port --kill <number>")}${pc.dim(" to skip the prompt and terminate every matching PID.")}`
    );
    out.println();
}

export function displayProcessTable(processes: ProcessSnapshot[], filtered: boolean): void {
    renderHeader("Process Overview", "beautiful ps for dev workflows");

    if (processes.length === 0) {
        out.println(pc.dim("  No matching processes found.\n"));
        out.println(pc.dim(`  Try ${pc.cyan("tools port ps --all")} to include system processes.\n`));
        return;
    }

    const table = createBoxTable(["PID", "PROCESS", "CPU%", "MEM", "PROJECT", "FRAMEWORK", "UPTIME", "WHAT"]);

    for (const processInfo of processes) {
        const what =
            processInfo.listeningPorts.length > 0
                ? `${processInfo.description} ${pc.dim(`[:${processInfo.listeningPorts.join(", :")}]`)}`
                : processInfo.description;

        table.push([
            pc.dim(String(processInfo.pid)),
            pc.white(pc.bold(truncateDisplay(processInfo.processName, 15))),
            formatCpu(processInfo.cpu),
            processInfo.memory ? pc.green(processInfo.memory) : pc.dim("—"),
            processInfo.projectName ? pc.blue(truncateDisplay(processInfo.projectName, 18)) : pc.dim("—"),
            formatFramework(processInfo.framework),
            processInfo.uptime ? pc.yellow(processInfo.uptime) : pc.dim("—"),
            pc.dim(truncateDisplay(what, 34)),
        ]);
    }

    out.println(table.toString());
    out.println();
    const filterHint = filtered ? `${pc.dim("  ·  ")}${pc.cyan("--all")}${pc.dim(" to show everything")}` : "";
    out.println(`${pc.dim(`  ${processes.length} process${processes.length === 1 ? "" : "es"}`)}${filterHint}`);
    out.println();
}

export function displayCleanPreview(orphaned: PortSnapshot[]): void {
    renderHeader("Port Cleanup", "find orphaned and zombie listeners");

    if (orphaned.length === 0) {
        out.println(pc.green("  ✓ No orphaned or zombie listeners found.\n"));
        return;
    }

    const table = createBoxTable(["PORT", "PID", "PROCESS", "PROJECT", "STATUS"]);

    for (const portInfo of orphaned) {
        table.push([
            pc.white(pc.bold(`:${portInfo.port}`)),
            pc.dim(String(portInfo.pid)),
            pc.white(portInfo.processName),
            portInfo.projectName ? pc.blue(truncateDisplay(portInfo.projectName, 18)) : pc.dim("—"),
            formatStatus(portInfo.status),
        ]);
    }

    out.println(table.toString());
    out.println();
}

export function displayCleanResults(orphaned: PortSnapshot[], results: KillResult[]): void {
    renderHeader("Port Cleanup", "cleanup results");

    if (orphaned.length === 0) {
        out.println(pc.green("  ✓ No orphaned or zombie listeners found.\n"));
        return;
    }

    for (const portInfo of orphaned) {
        const result = results.find((entry) => entry.pid === portInfo.pid);

        if (!result || result.status === "killed") {
            out.println(
                `  ${pc.green("✓")} :${pc.white(pc.bold(String(portInfo.port)))} ${pc.dim("—")} ${portInfo.processName} ${pc.dim(`(PID ${portInfo.pid})`)}`
            );
            continue;
        }

        if (result.status === "force-killed") {
            out.println(
                `  ${pc.yellow("!")} :${pc.white(pc.bold(String(portInfo.port)))} ${pc.dim("—")} ${portInfo.processName} ${pc.dim(`(PID ${portInfo.pid})`)} ${pc.yellow("forced")}`
            );
            continue;
        }

        out.println(
            `  ${pc.red("✕")} :${pc.white(pc.bold(String(portInfo.port)))} ${pc.dim("—")} ${portInfo.processName} ${pc.dim(`(PID ${portInfo.pid})`)}`
        );
        out.println(`    ${pc.red(result.error ?? "Failed to kill process")}`);
    }

    out.println();
}

export function displayWatchHeader(includeSystem: boolean, intervalMs: number): void {
    renderHeader("Port Watch", "monitor port activity in real time");
    out.println(pc.cyan(pc.bold("  Watching for port changes...")));
    out.println(pc.dim(`  Scope: ${includeSystem ? "all listeners" : "dev-focused listeners"} · poll ${intervalMs}ms`));
    out.println(pc.dim("  Press Ctrl+C to stop.\n"));
}

export interface PortSnapshotJson extends Omit<PortSnapshot, "startTime"> {
    startTime: string | null;
}

export interface ProcessSnapshotJson extends Omit<ProcessSnapshot, "startTime"> {
    startTime: string | null;
}

export function toPortJson(snapshots: PortSnapshot[]): PortSnapshotJson[] {
    return snapshots.map((snapshot) => ({
        ...snapshot,
        startTime: snapshot.startTime ? snapshot.startTime.toISOString() : null,
    }));
}

export function toProcessJson(processes: ProcessSnapshot[]): ProcessSnapshotJson[] {
    return processes.map((processInfo) => ({
        ...processInfo,
        startTime: processInfo.startTime ? processInfo.startTime.toISOString() : null,
    }));
}

export function displayWatchEvent(event: "new" | "removed", snapshot: PortSnapshot): void {
    const timestamp = pc.dim(new Date().toLocaleTimeString());

    if (event === "new") {
        const details = snapshot.projectName ? pc.blue(` [${snapshot.projectName}]`) : "";
        const framework = snapshot.framework ? ` ${formatFramework(snapshot.framework)}` : "";
        out.println(
            `  ${timestamp} ${pc.green("▲ OPEN")}   :${pc.white(pc.bold(String(snapshot.port)))} ← ${pc.white(snapshot.processName)}${details}${framework}`
        );
        return;
    }

    out.println(`  ${timestamp} ${pc.red("▼ CLOSED")} :${pc.white(pc.bold(String(snapshot.port)))}`);
}

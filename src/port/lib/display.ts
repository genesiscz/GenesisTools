import Table from "cli-table3";
import pc from "picocolors";
import type { KillResult, PortSnapshot, ProcessSnapshot } from "./types";

function createTable(headers: string[]): Table.Table {
    return new Table({
        chars: {
            top: "─",
            "top-mid": "┬",
            "top-left": "┌",
            "top-right": "┐",
            bottom: "─",
            "bottom-mid": "┴",
            "bottom-left": "└",
            "bottom-right": "┘",
            left: "│",
            "left-mid": "├",
            mid: "─",
            "mid-mid": "┼",
            right: "│",
            "right-mid": "┤",
            middle: "│",
        },
        head: headers.map((header) => pc.cyan(pc.bold(header))),
        style: {
            head: [],
            border: ["gray"],
            "padding-left": 1,
            "padding-right": 1,
        },
    });
}

function truncate(value: string | null | undefined, max: number): string {
    if (!value) {
        return "—";
    }

    if (value.length <= max) {
        return value;
    }

    return `${value.slice(0, max - 1)}…`;
}

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
            return `${pc.green("●")} ${pc.green("healthy")}`;
        case "orphaned":
            return `${pc.yellow("●")} ${pc.yellow("orphaned")}`;
        case "zombie":
            return `${pc.red("●")} ${pc.red("zombie")}`;
        default:
            return `${pc.dim("●")} ${pc.dim("unknown")}`;
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

export function renderHeader(title: string, subtitle: string): void {
    console.log();
    console.log(pc.cyan(pc.bold(" ┌─────────────────────────────────────┐")));
    console.log(
        `${pc.cyan(pc.bold(" │"))}${pc.white(pc.bold(`  ${truncate(title, 31).padEnd(31)}`))}${pc.cyan(pc.bold("│"))}`
    );
    console.log(`${pc.cyan(pc.bold(" │"))}${pc.dim(`  ${truncate(subtitle, 31).padEnd(31)}`)}${pc.cyan(pc.bold("│"))}`);
    console.log(pc.cyan(pc.bold(" └─────────────────────────────────────┘")));
    console.log();
}

export function displayPortTable(ports: PortSnapshot[], filtered: boolean): void {
    renderHeader("Port Overview", "listen to your ports");

    if (ports.length === 0) {
        console.log(pc.dim("  No matching listening ports found.\n"));
        console.log(pc.dim(`  Try ${pc.cyan("tools port --all")} to include system services.\n`));
        return;
    }

    const table = createTable(["PORT", "PROCESS", "PID", "PROJECT", "FRAMEWORK", "UPTIME", "STATUS"]);

    for (const portInfo of ports) {
        table.push([
            pc.white(pc.bold(`:${portInfo.port}`)),
            pc.white(portInfo.processName),
            pc.dim(String(portInfo.pid)),
            portInfo.projectName ? pc.blue(truncate(portInfo.projectName, 20)) : pc.dim("—"),
            formatFramework(portInfo.framework),
            portInfo.uptime ? pc.yellow(portInfo.uptime) : pc.dim("—"),
            formatStatus(portInfo.status),
        ]);
    }

    console.log(table.toString());
    console.log();
    const filterHint = filtered ? `${pc.dim("  ·  ")}${pc.cyan("--all")}${pc.dim(" to show everything")}` : "";
    console.log(
        `${pc.dim(`  ${ports.length} port${ports.length === 1 ? "" : "s"} active  ·  `)}${pc.dim("Run ")}${pc.cyan(
            "tools port <number>"
        )}${pc.dim(" for details")}${filterHint}`
    );
    console.log();
}

export function displayPortDetail(port: number, snapshots: PortSnapshot[], gitBranch: string | null): void {
    renderHeader(`Port :${port}`, "inspect and manage processes");

    if (snapshots.length === 0) {
        console.log(pc.red("  No process found on that port.\n"));
        return;
    }

    const table = createTable(["PID", "PROCESS", "USER", "STATE", "PROJECT", "FRAMEWORK", "UPTIME", "STATUS"]);

    for (const snapshot of snapshots) {
        table.push([
            pc.white(pc.bold(String(snapshot.pid))),
            pc.white(snapshot.processName),
            pc.dim(snapshot.user),
            snapshot.state === "LISTEN" ? pc.green(snapshot.state) : pc.yellow(snapshot.state),
            snapshot.projectName ? pc.blue(truncate(snapshot.projectName, 18)) : pc.dim("—"),
            formatFramework(snapshot.framework),
            snapshot.uptime ? pc.yellow(snapshot.uptime) : pc.dim("—"),
            formatStatus(snapshot.status),
        ]);
    }

    console.log(table.toString());
    console.log();

    const primary = snapshots[0];
    console.log(pc.cyan(pc.bold("  Location")));
    console.log(pc.dim("  ──────────────────────"));
    console.log(`  ${pc.dim("Directory".padEnd(14))} ${primary.cwd ? pc.blue(primary.cwd) : pc.dim("—")}`);
    console.log(`  ${pc.dim("Command".padEnd(14))} ${pc.white(truncate(primary.command, 80))}`);
    console.log(
        `  ${pc.dim("Started".padEnd(14))} ${primary.startTime ? pc.dim(primary.startTime.toLocaleString()) : pc.dim("—")}`
    );
    console.log(`  ${pc.dim("Memory".padEnd(14))} ${primary.memory ? pc.green(primary.memory) : pc.dim("—")}`);
    console.log(`  ${pc.dim("Git Branch".padEnd(14))} ${gitBranch ? pc.magenta(gitBranch) : pc.dim("—")}`);
    console.log();
    console.log(
        `${pc.dim("  Tip: use ")}${pc.cyan("tools port --kill <number>")}${pc.dim(" to skip the prompt and terminate every matching PID.")}`
    );
    console.log();
}

export function displayProcessTable(processes: ProcessSnapshot[], filtered: boolean): void {
    renderHeader("Process Overview", "beautiful ps for dev workflows");

    if (processes.length === 0) {
        console.log(pc.dim("  No matching processes found.\n"));
        console.log(pc.dim(`  Try ${pc.cyan("tools port ps --all")} to include system processes.\n`));
        return;
    }

    const table = createTable(["PID", "PROCESS", "CPU%", "MEM", "PROJECT", "FRAMEWORK", "UPTIME", "WHAT"]);

    for (const processInfo of processes) {
        const what =
            processInfo.listeningPorts.length > 0
                ? `${processInfo.description} ${pc.dim(`[:${processInfo.listeningPorts.join(", :")}]`)}`
                : processInfo.description;

        table.push([
            pc.dim(String(processInfo.pid)),
            pc.white(pc.bold(truncate(processInfo.processName, 15))),
            formatCpu(processInfo.cpu),
            processInfo.memory ? pc.green(processInfo.memory) : pc.dim("—"),
            processInfo.projectName ? pc.blue(truncate(processInfo.projectName, 18)) : pc.dim("—"),
            formatFramework(processInfo.framework),
            processInfo.uptime ? pc.yellow(processInfo.uptime) : pc.dim("—"),
            pc.dim(truncate(what, 34)),
        ]);
    }

    console.log(table.toString());
    console.log();
    const filterHint = filtered ? `${pc.dim("  ·  ")}${pc.cyan("--all")}${pc.dim(" to show everything")}` : "";
    console.log(`${pc.dim(`  ${processes.length} process${processes.length === 1 ? "" : "es"}`)}${filterHint}`);
    console.log();
}

export function displayCleanPreview(orphaned: PortSnapshot[]): void {
    renderHeader("Port Cleanup", "find orphaned and zombie listeners");

    if (orphaned.length === 0) {
        console.log(pc.green("  ✓ No orphaned or zombie listeners found.\n"));
        return;
    }

    const table = createTable(["PORT", "PID", "PROCESS", "PROJECT", "STATUS"]);

    for (const portInfo of orphaned) {
        table.push([
            pc.white(pc.bold(`:${portInfo.port}`)),
            pc.dim(String(portInfo.pid)),
            pc.white(portInfo.processName),
            portInfo.projectName ? pc.blue(truncate(portInfo.projectName, 18)) : pc.dim("—"),
            formatStatus(portInfo.status),
        ]);
    }

    console.log(table.toString());
    console.log();
}

export function displayCleanResults(orphaned: PortSnapshot[], results: KillResult[]): void {
    renderHeader("Port Cleanup", "cleanup results");

    if (orphaned.length === 0) {
        console.log(pc.green("  ✓ No orphaned or zombie listeners found.\n"));
        return;
    }

    for (const portInfo of orphaned) {
        const result = results.find((entry) => entry.pid === portInfo.pid);

        if (!result || result.status === "killed") {
            console.log(
                `  ${pc.green("✓")} :${pc.white(pc.bold(String(portInfo.port)))} ${pc.dim("—")} ${portInfo.processName} ${pc.dim(`(PID ${portInfo.pid})`)}`
            );
            continue;
        }

        if (result.status === "force-killed") {
            console.log(
                `  ${pc.yellow("!")} :${pc.white(pc.bold(String(portInfo.port)))} ${pc.dim("—")} ${portInfo.processName} ${pc.dim(`(PID ${portInfo.pid})`)} ${pc.yellow("forced")}`
            );
            continue;
        }

        console.log(
            `  ${pc.red("✕")} :${pc.white(pc.bold(String(portInfo.port)))} ${pc.dim("—")} ${portInfo.processName} ${pc.dim(`(PID ${portInfo.pid})`)}`
        );
        console.log(`    ${pc.red(result.error ?? "Failed to kill process")}`);
    }

    console.log();
}

export function displayWatchHeader(includeSystem: boolean, intervalMs: number): void {
    renderHeader("Port Watch", "monitor port activity in real time");
    console.log(pc.cyan(pc.bold("  Watching for port changes...")));
    console.log(pc.dim(`  Scope: ${includeSystem ? "all listeners" : "dev-focused listeners"} · poll ${intervalMs}ms`));
    console.log(pc.dim("  Press Ctrl+C to stop.\n"));
}

export function displayWatchEvent(event: "new" | "removed", snapshot: PortSnapshot): void {
    const timestamp = pc.dim(new Date().toLocaleTimeString());

    if (event === "new") {
        const details = snapshot.projectName ? pc.blue(` [${snapshot.projectName}]`) : "";
        const framework = snapshot.framework ? ` ${formatFramework(snapshot.framework)}` : "";
        console.log(
            `  ${timestamp} ${pc.green("▲ OPEN")}   :${pc.white(pc.bold(String(snapshot.port)))} ← ${pc.white(snapshot.processName)}${details}${framework}`
        );
        return;
    }

    console.log(`  ${timestamp} ${pc.red("▼ CLOSED")} :${pc.white(pc.bold(String(snapshot.port)))}`);
}

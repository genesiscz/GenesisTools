import { resolve } from "node:path";
import { getDaemonStatus } from "@app/daemon/lib/launchd";
import { isTaskRegistered, registerTask, unregisterTask } from "@app/daemon/lib/register";
import { SafeJSON } from "@app/utils/json";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";

const TASK_NAME = "wakeup-server";
const SERVER_SCRIPT = resolve(import.meta.dir, "../index.ts");

function bunPath(): string {
    return Bun.which("bun") ?? "bun";
}

function buildRegisterCommand(opts: {
    port: number;
    broadcast: string;
    mac?: string;
    token?: string;
    host?: string;
    wolPort: number;
    log?: boolean;
}): string {
    const parts = [
        bunPath(),
        "run",
        SafeJSON.stringify(SERVER_SCRIPT),
        "server",
        `--port ${opts.port}`,
        `--broadcast ${SafeJSON.stringify(opts.broadcast)}`,
        `--wol-port ${opts.wolPort}`,
        `--bind ${SafeJSON.stringify(opts.host ?? "0.0.0.0")}`,
    ];

    if (opts.mac) {
        parts.push(`--default-mac ${SafeJSON.stringify(opts.mac)}`);
    }

    if (opts.token) {
        parts.push(`--token ${SafeJSON.stringify(opts.token)}`);
    }

    if (opts.log) {
        parts.push("--log-requests");
    }

    return parts.join(" ");
}

export function registerDaemonCommands(program: Command): void {
    const daemon = program.command("daemon").description("Manage wakeup server via the daemon scheduler");

    daemon
        .command("register")
        .description("Register wakeup HTTP relay as a daemon task")
        .option("-p, --port <port>", "HTTP port to listen on", "8787")
        .option("--bind <host>", "Bind host", "0.0.0.0")
        .option("-b, --broadcast <addr>", "Broadcast address to target", "255.255.255.255")
        .option("-m, --mac <mac>", "Default target MAC address")
        .option("-t, --token <token>", "Shared secret token for HTTP requests")
        .option("--wol-port <port>", "UDP port for magic packet", "9")
        .option("--log-requests", "Log incoming wake attempts", false)
        .action(async (opts: Record<string, unknown>) => {
            const port = Number(opts.port ?? 8787);
            const broadcast = (opts.broadcast as string | undefined) ?? "255.255.255.255";
            const mac = opts.mac as string | undefined;
            const token = opts.token as string | undefined;
            const host = (opts.bind as string | undefined) ?? "0.0.0.0";
            const wolPort = Number(opts.wolPort ?? 9);
            const logRequests = Boolean(opts.logRequests);

            if (Number.isNaN(port) || port <= 0 || port > 65535) {
                p.log.error("Invalid port");
                process.exit(1);
            }

            if (Number.isNaN(wolPort) || wolPort <= 0 || wolPort > 65535) {
                p.log.error("Invalid wol-port");
                process.exit(1);
            }

            const command = buildRegisterCommand({
                port,
                broadcast,
                mac,
                token,
                host,
                wolPort,
                log: logRequests,
            });

            const created = await registerTask({
                name: TASK_NAME,
                command,
                every: "every 1 minute",
                retries: 0,
                description: "Wake-on-LAN relay HTTP server",
                overwrite: true,
            });

            if (created) {
                p.log.success(`Registered task ${pc.cyan(TASK_NAME)} (${port})`);
            } else {
                p.log.info(`Updated task ${pc.cyan(TASK_NAME)} (${port})`);
            }

            const status = await getDaemonStatus();

            if (!status.running) {
                p.log.warn(
                    `Daemon is not running. Start it with: ${pc.cyan("tools daemon start")} or ${pc.cyan("tools daemon install")}`
                );
            }
        });

    daemon
        .command("unregister")
        .description("Remove wakeup server task")
        .action(async () => {
            const removed = await unregisterTask(TASK_NAME);

            if (removed) {
                p.log.success(`Removed task ${pc.cyan(TASK_NAME)}`);
            } else {
                p.log.warn(`Task ${pc.cyan(TASK_NAME)} was not registered`);
            }
        });

    daemon
        .command("status")
        .description("Check daemon and wakeup task status")
        .action(async () => {
            const registered = await isTaskRegistered(TASK_NAME);
            const daemonStatus = await getDaemonStatus();

            if (registered) {
                p.log.success(`Task ${pc.cyan(TASK_NAME)} is registered`);
            } else {
                p.log.warn(
                    `Task ${pc.cyan(TASK_NAME)} is not registered. Run: ${pc.cyan("tools wakeup daemon register")}`
                );
            }

            if (daemonStatus.running) {
                p.log.success(`Daemon running (PID ${daemonStatus.pid})`);
            } else if (daemonStatus.installed) {
                p.log.warn("Daemon installed but not running");
            } else {
                p.log.info(`Daemon not installed. Run: ${pc.cyan("tools daemon install")}`);
            }
        });
}

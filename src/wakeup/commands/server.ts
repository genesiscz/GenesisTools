import type { Storage } from "@app/utils/storage";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import { DEFAULT_HTTP_PORT, DEFAULT_WOL_PORT, mergeRole, readWakeupConfig, updateWakeupConfig } from "../config";
import { runWakeServer } from "../lib/server";
import { getDefaultInterface } from "../network";

interface ServerSetupResult {
    host: string;
    port: number;
    broadcast: string;
    wolPort: number;
    defaultMac?: string;
    token?: string;
    logRequests: boolean;
}

function ensureNotCancelled<T>(value: T): T {
    if (p.isCancel(value)) {
        p.cancel("Cancelled");
        process.exit(0);
    }

    if (value === undefined || value === null) {
        p.cancel("Cancelled");
        process.exit(1);
    }

    return value;
}

async function promptServerSettings(storage: Storage): Promise<ServerSetupResult> {
    const config = await readWakeupConfig(storage);
    const defaults = config.server ?? {};
    const iface = getDefaultInterface();

    if (iface) {
        p.note(`Detected ${iface.name} (${iface.address}) broadcast ${iface.broadcast}`, "Network defaults");
    }

    const answers = await p.group(
        {
            host: () =>
                p.text({
                    message: "Bind host",
                    initialValue: defaults.host ?? "0.0.0.0",
                    placeholder: "0.0.0.0",
                }),
            port: () =>
                p.text({
                    message: "HTTP port",
                    initialValue: String(defaults.port ?? DEFAULT_HTTP_PORT),
                    validate: (value) => {
                        const port = Number.parseInt(value ?? "", 10);
                        if (Number.isNaN(port) || port <= 0 || port > 65535) {
                            return "Enter a valid port (1-65535)";
                        }
                    },
                }),
            broadcast: () =>
                p.text({
                    message: "Default broadcast address",
                    initialValue: defaults.broadcast ?? iface?.broadcast ?? "255.255.255.255",
                }),
            wolPort: () =>
                p.text({
                    message: "UDP port for magic packet",
                    initialValue: String(defaults.wolPort ?? DEFAULT_WOL_PORT),
                    validate: (value) => {
                        const port = Number.parseInt(value ?? "", 10);
                        if (Number.isNaN(port) || port <= 0 || port > 65535) {
                            return "Enter a valid port (1-65535)";
                        }
                    },
                }),
            defaultMac: () =>
                p.text({
                    message: "Default target MAC (optional)",
                    initialValue: defaults.defaultMac ?? iface?.mac ?? "",
                    placeholder: iface?.mac ?? "01:23:45:67:89:ab",
                }),
            token: () =>
                p.text({
                    message: "Shared token (optional, secures all requests)",
                    initialValue: defaults.token ?? "",
                }),
            logRequests: () =>
                p.confirm({
                    message: "Log wakeup requests?",
                    initialValue: defaults.logRequests ?? true,
                }),
        },
        {
            onCancel: () => {
                p.cancel("Cancelled");
                process.exit(0);
            },
        }
    );

    const host = String(ensureNotCancelled(answers.host)).trim() || "0.0.0.0";
    const port = Number.parseInt(String(ensureNotCancelled(answers.port)), 10);
    const broadcast = String(ensureNotCancelled(answers.broadcast)).trim() || "255.255.255.255";
    const wolPort = Number.parseInt(String(ensureNotCancelled(answers.wolPort)), 10);
    const defaultMac = String(ensureNotCancelled(answers.defaultMac)).trim() || undefined;
    const token = String(ensureNotCancelled(answers.token)).trim() || undefined;
    const logRequests = Boolean(answers.logRequests);

    return { host, port, broadcast, wolPort, defaultMac, token, logRequests };
}

export async function runServerSetup(storage: Storage): Promise<void> {
    p.intro("Wakeup server");
    const settings = await promptServerSettings(storage);

    await updateWakeupConfig(storage, (current) => ({
        ...current,
        role: mergeRole(current.role, "server"),
        server: {
            ...(current.server ?? {}),
            host: settings.host,
            port: settings.port,
            broadcast: settings.broadcast,
            wolPort: settings.wolPort,
            defaultMac: settings.defaultMac,
            token: settings.token,
            logRequests: settings.logRequests,
        },
    }));

    p.outro("Server configured. Starting server...");

    await runWakeServer({
        port: settings.port,
        hostname: settings.host,
        broadcast: settings.broadcast,
        wolPort: settings.wolPort,
        defaultMac: settings.defaultMac,
        token: settings.token,
        logRequests: settings.logRequests,
        storage,
    });
}

export function registerServerCommand(program: Command, storage: Storage): void {
    program
        .command("server")
        .description("Guide through starting a wakeup relay server")
        .action(async () => {
            await runServerSetup(storage);
        });
}

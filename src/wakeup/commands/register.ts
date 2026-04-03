import type { Storage } from "@app/utils/storage";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import {
    DEFAULT_HTTP_PORT,
    DEFAULT_WOL_PORT,
    mergeRole,
    parseServerInput,
    readWakeupConfig,
    updateWakeupConfig,
} from "../config";
import { postJson } from "../http";
import { listInterfaces } from "../network";

interface RegisterResponse {
    ok: boolean;
}

function assertNotCancelled<T>(value: T): T {
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

function buildInterfaceOptions() {
    const interfaces = listInterfaces();

    if (interfaces.length === 0) {
        return [];
    }

    return interfaces.map((iface) => ({
        value: iface.id,
        label: `${iface.name} (${iface.address})`,
        hint: `mac ${iface.mac}, broadcast ${iface.broadcast}`,
    }));
}

export async function runRegisterFlow(storage: Storage): Promise<void> {
    p.intro("Register this device");

    const config = await readWakeupConfig(storage);
    const serverHost = config.server?.host ?? "localhost";
    const serverPort = config.server?.port ?? DEFAULT_HTTP_PORT;
    const interfaceOptions = buildInterfaceOptions();

    const answers = await p.group(
        {
            server: () =>
                p.text({
                    message: "Server host:port",
                    initialValue: `${serverHost}:${serverPort}`,
                    placeholder: "server.local:8787",
                    validate: (value) => {
                        const trimmed = (value ?? "").trim();
                        if (!trimmed) {
                            return "Provide a server host";
                        }
                    },
                }),
            name: () =>
                p.text({
                    message: "Device name",
                    initialValue: config.client?.name ?? "",
                }),
            password: () =>
                p.password({
                    message: "Device password",
                }),
            iface: async () => {
                if (interfaceOptions.length === 0) {
                    return "manual";
                }

                return p.select({
                    message: "Network interface to use",
                    options: [...interfaceOptions, { value: "manual", label: "Enter values manually" }],
                    initialValue: interfaceOptions[0]?.value ?? "manual",
                });
            },
            mac: async ({ results }) => {
                const ifaceId = results.iface ? String(results.iface) : undefined;

                if (ifaceId && ifaceId !== "manual") {
                    const chosen = listInterfaces().find((item) => item.id === ifaceId);
                    if (chosen) {
                        return chosen.mac;
                    }
                }

                return p.text({
                    message: "Target MAC",
                    placeholder: "01:23:45:67:89:ab",
                    initialValue: config.client?.mac ?? "",
                });
            },
            broadcast: async ({ results }) => {
                const ifaceId = results.iface ? String(results.iface) : undefined;

                if (ifaceId && ifaceId !== "manual") {
                    const chosen = listInterfaces().find((item) => item.id === ifaceId);
                    if (chosen) {
                        return chosen.broadcast;
                    }
                }

                return p.text({
                    message: "Broadcast address",
                    placeholder: "255.255.255.255",
                    initialValue: config.client?.broadcast ?? config.server?.broadcast ?? "",
                });
            },
        },
        {
            onCancel: () => {
                p.cancel("Cancelled");
                process.exit(0);
            },
        }
    );

    const serverInput = String(assertNotCancelled(answers.server ?? ""));
    const { host, port } = parseServerInput(serverInput);
    const name = String(assertNotCancelled(answers.name)).trim();
    const password = String(assertNotCancelled(answers.password)).trim();
    const mac = typeof answers.mac === "string" ? answers.mac.trim() : String(answers.mac ?? "");
    const broadcast =
        typeof answers.broadcast === "string" ? answers.broadcast.trim() : String(answers.broadcast ?? "");
    const wolPort = config.client?.wolPort ?? config.server?.wolPort ?? DEFAULT_WOL_PORT;

    if (!name || !password) {
        p.cancel("Name and password are required");
        process.exit(1);
    }

    if (!mac) {
        p.cancel("MAC address is required");
        process.exit(1);
    }

    const spinner = p.spinner();
    spinner.start("Registering with server...");

    try {
        const token = config.server?.token;

        await postJson<RegisterResponse>({ host, port, token }, "/register", {
            name,
            password,
            mac,
            broadcast: broadcast || "255.255.255.255",
            port: wolPort,
        });

        spinner.stop("Registered successfully");
    } catch (error) {
        spinner.stop("Registration failed");
        const message = error instanceof Error ? error.message : String(error);
        p.log.error(message);
        process.exit(1);
    }

    await updateWakeupConfig(storage, (current) => ({
        ...current,
        role: mergeRole(current.role, "client"),
        server: {
            ...(current.server ?? {}),
            host,
            port,
        },
        client: {
            ...(current.client ?? {}),
            name,
            password,
            mac,
            broadcast: broadcast || "255.255.255.255",
            wolPort,
            serverHost: host,
            serverPort: port,
        },
    }));

    p.outro(`Saved config to ${storage.getConfigPath()}`);
}

export function registerClientCommand(program: Command, storage: Storage): void {
    program
        .command("register")
        .description("Register this machine with the wakeup server (auto-fills MAC/broadcast)")
        .action(async () => {
            await runRegisterFlow(storage);
        });
}

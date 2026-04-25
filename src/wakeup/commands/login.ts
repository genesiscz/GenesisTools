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

interface LoginResponse {
    ok: boolean;
    client?: {
        name?: string;
        mac?: string;
        broadcast?: string;
        wolPort?: number;
    };
}

function requireValue<T>(value: T, message: string): T {
    if (p.isCancel(value)) {
        p.cancel("Cancelled");
        process.exit(0);
    }

    if (typeof value === "string" && value.trim().length === 0) {
        p.cancel(message);
        process.exit(1);
    }

    return value;
}

export async function runLoginFlow(storage: Storage): Promise<void> {
    p.intro("Login to wakeup server");
    const config = await readWakeupConfig(storage);
    const serverHost = config.server?.host ?? config.client?.serverHost ?? "localhost";
    const serverPort = config.server?.port ?? config.client?.serverPort ?? DEFAULT_HTTP_PORT;

    const answers = await p.group(
        {
            server: () =>
                p.text({
                    message: "Server host:port",
                    initialValue: `${serverHost}:${serverPort}`,
                }),
            name: () =>
                p.text({
                    message: "Device name",
                    initialValue: config.client?.name ?? "",
                }),
            password: () =>
                p.password({
                    message: "Password",
                }),
        },
        {
            onCancel: () => {
                p.cancel("Cancelled");
                process.exit(0);
            },
        }
    );

    const { host, port } = parseServerInput(String(requireValue(answers.server, "Server required")));
    const name = String(requireValue(answers.name, "Name required")).trim();
    const password = String(requireValue(answers.password, "Password required")).trim();

    const spinner = p.spinner();
    spinner.start("Contacting server...");

    try {
        const token = config.server?.token;
        const response = await postJson<LoginResponse>({ host, port, token }, "/login", { name, password });

        spinner.stop("Login acknowledged");

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
                mac: response.client?.mac ?? current.client?.mac,
                broadcast: response.client?.broadcast ?? current.client?.broadcast,
                wolPort: response.client?.wolPort ?? current.client?.wolPort ?? DEFAULT_WOL_PORT,
                serverHost: host,
                serverPort: port,
            },
        }));
    } catch (error) {
        spinner.stop("Login failed");
        const message = error instanceof Error ? error.message : String(error);
        p.log.error(message);
        process.exit(1);
    }

    p.outro("Saved login details");
}

export function registerLoginCommand(program: Command, storage: Storage): void {
    program
        .command("login")
        .description("Login to a wakeup server and save credentials")
        .action(async () => {
            await runLoginFlow(storage);
        });
}

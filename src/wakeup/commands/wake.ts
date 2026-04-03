import { setTimeout as delay } from "node:timers/promises";
import type { Storage } from "@app/utils/storage";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import { DEFAULT_HTTP_PORT, mergeRole, readWakeupConfig, updateWakeupConfig } from "../config";
import { postJson } from "../http";
import { runLoginFlow } from "./login";

interface WakeResponse {
    ok: boolean;
    mac?: string;
    broadcast?: string;
    port?: number;
}

function ensure<T>(value: T): T {
    if (p.isCancel(value)) {
        p.cancel("Cancelled");
        process.exit(0);
    }

    return value;
}

async function chooseCredentials(storage: Storage): Promise<{ name: string; password: string }> {
    let config = await readWakeupConfig(storage);
    const savedName = config.client?.name;

    if (!config.server?.host || !config.server?.port || !savedName) {
        await runLoginFlow(storage);
        config = await readWakeupConfig(storage);
    } else {
        const choice = await p.select({
            message: "Use saved login or switch?",
            options: [
                { value: "saved", label: `Use ${savedName}` },
                { value: "login", label: "Login with different credentials" },
            ],
            initialValue: "saved",
        });

        if (String(choice) === "login") {
            await runLoginFlow(storage);
            config = await readWakeupConfig(storage);
        }
    }

    const name = config.client?.name;
    const password = config.client?.password;

    if (!name || !password) {
        p.cancel("No credentials saved");
        process.exit(1);
    }

    return { name, password };
}

function parseDelayChoice(choice: string): number {
    if (choice === "now") {
        return 0;
    }

    if (choice === "10s") {
        return 10_000;
    }

    if (choice === "30s") {
        return 30_000;
    }

    if (choice === "60s") {
        return 60_000;
    }

    return 0;
}

async function promptDelay(): Promise<number> {
    const choice = await p.select({
        message: "When to wake?",
        initialValue: "now",
        options: [
            { value: "now", label: "Now" },
            { value: "10s", label: "In 10 seconds" },
            { value: "30s", label: "In 30 seconds" },
            { value: "60s", label: "In 1 minute" },
            { value: "custom", label: "Custom delay (seconds)" },
        ],
    });

    if (String(choice) === "custom") {
        const custom = await p.text({
            message: "Seconds to wait",
            validate: (value) => {
                const seconds = Number.parseInt(value ?? "", 10);
                if (Number.isNaN(seconds) || seconds < 0) {
                    return "Enter a valid number";
                }
            },
        });

        const seconds = Number.parseInt(String(ensure(custom)), 10);
        return seconds * 1000;
    }

    return parseDelayChoice(String(ensure(choice)));
}

export async function runWakeFlow(storage: Storage): Promise<void> {
    p.intro("Wake a registered device");

    const delayMs = await promptDelay();
    const { name, password } = await chooseCredentials(storage);
    const config = await readWakeupConfig(storage);
    const serverHost = config.server?.host ?? config.client?.serverHost ?? "localhost";
    const serverPort = config.server?.port ?? config.client?.serverPort ?? DEFAULT_HTTP_PORT;
    const token = config.server?.token;

    if (delayMs > 0) {
        p.log.info(`Waiting ${Math.round(delayMs / 1000)}s before sending wake request...`);
        await delay(delayMs);
    }

    const spinner = p.spinner();
    spinner.start("Sending wake request...");

    try {
        const result = await postJson<WakeResponse>({ host: serverHost, port: serverPort, token }, "/wake", {
            name,
            password,
        });

        spinner.stop(`Server acknowledged wake for ${result.mac ?? name}`);

        await updateWakeupConfig(storage, (current) => ({
            ...current,
            role: mergeRole(current.role, "client"),
            client: {
                ...(current.client ?? {}),
                name,
                password,
                mac: result.mac ?? current.client?.mac,
                broadcast: result.broadcast ?? current.client?.broadcast,
                wolPort: result.port ?? current.client?.wolPort,
                serverHost,
                serverPort,
            },
            server: {
                ...(current.server ?? {}),
                host: serverHost,
                port: serverPort,
            },
        }));
    } catch (error) {
        spinner.stop("Wake failed");
        const message = error instanceof Error ? error.message : String(error);
        p.log.error(message);
        process.exit(1);
    }

    p.outro("Wake request complete");
}

export function registerWakeCommand(program: Command, storage: Storage): void {
    program
        .command("wake")
        .description("Wake a registered device")
        .action(async () => {
            await runWakeFlow(storage);
        });
}

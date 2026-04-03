import type { Storage } from "@app/utils/storage";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import { mergeRole, readWakeupConfig, updateWakeupConfig } from "../config";
import { runLoginFlow } from "./login";
import { runRegisterFlow } from "./register";
import { runServerSetup } from "./server";

export async function runConfigurationMenu(storage: Storage): Promise<void> {
    p.intro("Wakeup configuration");

    const config = await readWakeupConfig(storage);
    const roleChoice = await p.select({
        message: "What best describes this device?",
        options: [
            { value: "server", label: "Server (runs the relay)" },
            { value: "client", label: "Client (sends wake requests)" },
            { value: "both", label: "Both" },
        ],
        initialValue: config.role ?? "both",
    });

    if (p.isCancel(roleChoice)) {
        p.cancel("Cancelled");
        process.exit(0);
    }

    await updateWakeupConfig(storage, (current) => ({
        ...current,
        role: mergeRole(current.role, roleChoice),
    }));

    const next = await p.select({
        message: "Next step",
        options: [
            { value: "server", label: "Setup and start server" },
            { value: "register", label: "Register this device with the server" },
            { value: "login", label: "Login to the server" },
            { value: "done", label: "Done" },
        ],
        initialValue: "done",
    });

    if (next === "server") {
        await runServerSetup(storage);
    } else if (next === "register") {
        await runRegisterFlow(storage);
    } else if (next === "login") {
        await runLoginFlow(storage);
    } else {
        p.outro(`Saved role (${roleChoice})`);
    }
}

export function registerConfigCommand(program: Command, storage: Storage): void {
    program
        .command("config")
        .description("Choose device role and guided setup")
        .action(async () => {
            await runConfigurationMenu(storage);
        });
}

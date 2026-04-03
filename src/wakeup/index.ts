#!/usr/bin/env bun

import { handleReadmeFlag } from "@app/utils/readme";
import { Storage } from "@app/utils/storage";
import * as p from "@clack/prompts";
import { Command } from "commander";
import { registerConfigCommand, runConfigurationMenu } from "./commands/config";
import { registerDaemonCommands } from "./commands/daemon";
import { registerLoginCommand } from "./commands/login";
import { registerClientCommand } from "./commands/register";
import { registerSendCommand, runSendFlow } from "./commands/send";
import { registerServerCommand } from "./commands/server";
import { registerWakeCommand, runWakeFlow } from "./commands/wake";
import { readWakeupConfig } from "./config";

handleReadmeFlag(import.meta.url);

const program = new Command();
const storage = new Storage("wakeup");

program.name("wakeup").description("Wake-on-LAN helper and tiny wake relay").version("1.0.0");

registerConfigCommand(program, storage);
registerServerCommand(program, storage);
registerClientCommand(program, storage);
registerLoginCommand(program, storage);
registerWakeCommand(program, storage);
registerSendCommand(program, storage);
registerDaemonCommands(program);

program.action(async () => {
    let config = await readWakeupConfig(storage);

    if (!config.role) {
        await runConfigurationMenu(storage);
        config = await readWakeupConfig(storage);
    }

    const choice = await p.select({
        message: "What do you want to do?",
        options: [
            { value: "wake", label: "Wake a device" },
            { value: "config", label: "Configuration" },
            { value: "send", label: "Send raw magic packet" },
        ],
        initialValue: "wake",
    });

    if (p.isCancel(choice)) {
        p.cancel("Cancelled");
        process.exit(0);
    }

    if (choice === "config") {
        await runConfigurationMenu(storage);
        return;
    }

    if (choice === "send") {
        await runSendFlow(storage);
        return;
    }

    await runWakeFlow(storage);
});

async function main(): Promise<void> {
    try {
        await program.parseAsync(process.argv);
    } catch (error) {
        p.log.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    }
}

main().catch((err) => {
    p.log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
});

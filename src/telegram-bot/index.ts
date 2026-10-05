#!/usr/bin/env bun

import { runTool } from "@genesiscz/utils/cli";
import { handleReadmeFlag } from "@genesiscz/utils/readme";
import { Command } from "commander";
import { registerConfigureCommand } from "./commands/configure";
import { registerSendCommand } from "./commands/send";
import { registerStartCommand } from "./commands/start";
import { registerWebhookCommand } from "./commands/webhook";

handleReadmeFlag(import.meta.url);

const program = new Command();
program
    .name("telegram-bot")
    .description("Telegram Bot for GenesisTools notifications and remote control")
    .version("1.0.0")
    .showHelpAfterError(true);

registerConfigureCommand(program);
registerSendCommand(program);
registerStartCommand(program);
registerWebhookCommand(program);

await runTool(program, { tool: "telegram-bot" });

#!/usr/bin/env bun

import { Command } from "commander";
import { handleReadmeFlag } from "@app/utils/readme";
import { registerConfigureCommand } from "./commands/configure";
import { registerSendCommand } from "./commands/send";
import { registerStartCommand } from "./commands/start";

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

program.parse();

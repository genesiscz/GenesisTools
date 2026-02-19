#!/usr/bin/env bun

import { Command } from "commander";
import * as p from "@clack/prompts";
import { handleReadmeFlag } from "@app/utils/readme.ts";
import { ensureStorage } from "@app/automate/lib/storage.ts";
import { registerRunCommand } from "@app/automate/commands/run.ts";
import { registerListCommand } from "@app/automate/commands/list.ts";
import { registerShowCommand } from "@app/automate/commands/show.ts";
import { registerCreateCommand } from "@app/automate/commands/create.ts";
import { registerCredentialsCommand } from "@app/automate/commands/credentials.ts";
import { registerScheduleCommand } from "@app/automate/commands/schedule.ts";
import { registerTasksCommand } from "@app/automate/commands/tasks.ts";
import { registerDaemonCommand } from "@app/automate/commands/daemon.ts";
import { registerConfigureCommand } from "@app/automate/commands/configure.ts";
import logger from "@app/logger.ts";

// Handle --readme flag early (before Commander parses)
handleReadmeFlag(import.meta.url);

const program = new Command();

program
  .name("automate")
  .description("Run and manage automation presets that chain GenesisTools commands")
  .version("1.0.0")
  .showHelpAfterError(true);

registerRunCommand(program);
registerListCommand(program);
registerShowCommand(program);
registerCreateCommand(program);
registerCredentialsCommand(program);
registerScheduleCommand(program);
registerTasksCommand(program);
registerDaemonCommand(program);
registerConfigureCommand(program);

async function main(): Promise<void> {
  await ensureStorage();

  if (process.argv.length <= 2) {
    program.help();
    return;
  }

  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    logger.error({ error }, "Automate command failed");
    p.log.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main().catch((err) => {
  logger.error(`Unexpected error: ${err}`);
  process.exit(1);
});

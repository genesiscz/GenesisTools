#!/usr/bin/env bun
import { handleReadmeFlag } from "@app/utils/readme";
import { Command } from "commander";
import { registerCrawlCommand } from "./commands/crawl";
import { registerDaemonCommand } from "./commands/daemon";
import { registerDbCommand } from "./commands/db";
import { registerDbPruneCommand } from "./commands/db-prune";
import { registerGetCommand } from "./commands/get";
import { registerListCommand } from "./commands/list";
import { registerNotifyCommand } from "./commands/notify";
import { registerShopsCommand } from "./commands/shops";
import { registerWatchCommand } from "./commands/watch";

handleReadmeFlag(import.meta.url);

const program = new Command();

program
    .name("shops")
    .description("Personal grocery + drogerie + pharmacy price intelligence across Czech eshops")
    .version("0.1.0");

registerGetCommand(program);
registerDbCommand(program);
registerShopsCommand(program);
registerWatchCommand(program);
registerNotifyCommand(program);
registerDbPruneCommand(program);
registerDaemonCommand(program);
registerCrawlCommand(program);
registerListCommand(program);

await program.parseAsync(process.argv);

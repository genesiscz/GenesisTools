#!/usr/bin/env bun
import { handleReadmeFlag } from "@app/utils/readme";
import { Command } from "commander";
import { registerCrawlCommand } from "./commands/crawl";
import { registerDaemonCommand } from "./commands/daemon";
import { registerDbCommand } from "./commands/db";
import { registerDbPruneCommand } from "./commands/db-prune";
import { registerDevCaptureFixtureCommand } from "./commands/dev-capture-fixture";
import { registerGetCommand } from "./commands/get";
import { registerListCommand } from "./commands/list";
import { registerMatchCommand } from "./commands/match";
import { registerMcpCommand } from "./commands/mcp";
import { registerNotifyCommand } from "./commands/notify";
import { registerShopsCommand } from "./commands/shops";
import { registerSitemapCrawlCommand } from "./commands/sitemap-crawl";
import { registerSitemapSyncCommand } from "./commands/sitemap-sync";
import { registerUiCommand } from "./commands/ui";
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
registerSitemapSyncCommand(program);
registerSitemapCrawlCommand(program);
registerListCommand(program);
registerMatchCommand(program);
registerMcpCommand(program);
registerUiCommand(program);
registerDevCaptureFixtureCommand(program);

await program.parseAsync(process.argv);

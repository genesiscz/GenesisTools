#!/usr/bin/env bun
import { registerCrawlCommand } from "@app/shops/commands/crawl";
import { registerDaemonCommand } from "@app/shops/commands/daemon";
import { registerDbCommand } from "@app/shops/commands/db";
import { registerDbPruneCommand } from "@app/shops/commands/db-prune";
import { registerDevCaptureFixtureCommand } from "@app/shops/commands/dev-capture-fixture";
import { registerGetCommand } from "@app/shops/commands/get";
import { registerListCommand } from "@app/shops/commands/list";
import { registerMatchCommand } from "@app/shops/commands/match";
import { registerMcpCommand } from "@app/shops/commands/mcp";
import { registerNotifyCommand } from "@app/shops/commands/notify";
import { registerProviderConnectCommand } from "@app/shops/commands/provider-connect";
import { registerShopsCommand } from "@app/shops/commands/shops";
import { registerSitemapCrawlCommand } from "@app/shops/commands/sitemap-crawl";
import { registerSitemapSyncCommand } from "@app/shops/commands/sitemap-sync";
import { registerUiCommand } from "@app/shops/commands/ui";
import { registerWatchCommand } from "@app/shops/commands/watch";
import { handleReadmeFlag } from "@app/utils/readme";
import { Command } from "commander";

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
registerProviderConnectCommand(program);

await program.parseAsync(process.argv);

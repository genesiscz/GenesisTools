#!/usr/bin/env bun
import { handleReadmeFlag } from "@app/utils/readme";
import { Command } from "commander";
import { registerDbCommand } from "./commands/db";
import { registerGetCommand } from "./commands/get";
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

await program.parseAsync(process.argv);

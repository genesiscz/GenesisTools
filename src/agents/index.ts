#!/usr/bin/env bun

import { runTool } from "@genesiscz/utils/cli";
import { handleReadmeFlag } from "@genesiscz/utils/readme";
import { Command } from "commander";
import { registerDiscoverCommand } from "./commands/discover";
import { registerListenCommand } from "./commands/listen";
import { registerLoginCommand } from "./commands/login";
import { registerMessageCommand } from "./commands/message";
import { registerRequestCommand } from "./commands/request";

handleReadmeFlag(import.meta.url);

const program = new Command();

program
    .name("agents")
    .description("Cross-agent communication: register/login/message/discover/listen across the swarm")
    .version("0.1.0");

registerLoginCommand(program);
registerMessageCommand(program);
registerRequestCommand(program);
registerDiscoverCommand(program);
registerListenCommand(program);

await runTool(program, { tool: "agents" });

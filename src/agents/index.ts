#!/usr/bin/env bun

import { runTool } from "@app/utils/cli";
import { handleReadmeFlag } from "@app/utils/readme";
import { Command } from "commander";
import { registerDiscoverCommand } from "./commands/discover";
import { registerListenCommand } from "./commands/listen";
import { registerLoginCommand } from "./commands/login";
import { registerMessageCommand } from "./commands/message";

handleReadmeFlag(import.meta.url);

const program = new Command();

program
    .name("agents")
    .description("Cross-agent communication: register/login/message/discover/listen across the swarm")
    .version("0.1.0");

registerLoginCommand(program);
registerMessageCommand(program);
registerDiscoverCommand(program);
registerListenCommand(program);

await runTool(program, { tool: "agents" });

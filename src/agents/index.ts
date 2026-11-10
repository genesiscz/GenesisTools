#!/usr/bin/env bun

import { runTool } from "@genesiscz/utils/cli";
import { Command } from "commander";
import { AGENTS_REGISTRARS } from "./registrars";

const program = new Command();

program
    .name("agents")
    .description("Cross-agent communication: register/login/message/discover/listen across the swarm")
    .version("0.1.0");

await runTool(program, { tool: "agents", registrars: AGENTS_REGISTRARS });

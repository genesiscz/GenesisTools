#!/usr/bin/env bun
/**
 * tools scripts — call MCP tools from plain TypeScript, no agent loop.
 *
 * Probe an already-configured surface's schema, generate typed bindings, and
 * keep the result as a persisted Bun script. v1 speaks MCP; the selector
 * grammar reserves a provider prefix (`mcp:server.tool`) so future surfaces
 * (openapi:, composio:, graphql:, gt:) slot in without breaking anything —
 * a bare selector means `mcp:` forever.
 *
 *   tools scripts servers                  what exists, and how it connects
 *   tools scripts tools 'genesis-tools.*'  live tools/list, cached after first probe
 *   tools scripts call genesis-tools.handoff_list '{"limit":5}'
 *   tools scripts create colTriage --import 'chrome-devtools-mcp.*'
 *   tools scripts run colTriage
 */
import { runTool } from "@genesiscz/utils/cli";
import { Command } from "commander";
import { registerCall } from "./commands/call.ts";
import { registerCreate } from "./commands/create.ts";
import { registerDescribe } from "./commands/describe.ts";
import { registerDoctor } from "./commands/doctor.ts";
import { registerGit, registerRemote } from "./commands/git.ts";
import { registerList } from "./commands/list.ts";
import { registerRegen } from "./commands/regen.ts";
import { registerRename } from "./commands/rename.ts";
import { registerRm } from "./commands/rm.ts";
import { registerRun } from "./commands/run.ts";
import { registerServers } from "./commands/servers.ts";
import { registerShow } from "./commands/show.ts";
import { registerTag } from "./commands/tag.ts";
import { registerTools } from "./commands/tools.ts";

const program = new Command();
program.name("tools scripts").description("Script MCP tool calls directly. No agent loop.").version("0.1.0");

registerServers(program);
registerTools(program);
registerDescribe(program);
registerCall(program);
registerCreate(program);
registerList(program);
registerShow(program);
registerRun(program);
registerRegen(program);
registerRename(program);
registerTag(program);
registerRm(program);
registerRemote(program);
registerGit(program);
registerDoctor(program);

await runTool(program, { tool: "scripts" });

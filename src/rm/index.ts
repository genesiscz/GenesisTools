#!/usr/bin/env bun

import { runTool } from "@genesiscz/utils/cli";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { Command } from "commander";
import { registerRemoveCommand } from "./commands/remove";
import { registerRequestCommands } from "./commands/requests";
import { registerRootCommands } from "./commands/roots";
import { registerSettingsCommands } from "./commands/settings";
import { registerTrashCommands } from "./commands/trash";

const program = new Command();

program
    .name(`${toolCommand("rm")}`)
    .description(
        "Safe delete for agents and people: presets for build output, the session's own files, trusted roots, " +
            "a request the user confirms for anything else; items move to a trash that drains in the background"
    );

registerRemoveCommand(program);
registerSettingsCommands(program);
registerRequestCommands(program);
registerRootCommands(program);
registerTrashCommands(program);

if (import.meta.main) {
    await runTool(program, { tool: "rm" });
}

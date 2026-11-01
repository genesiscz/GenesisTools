import { addGlobalVerboseOption } from "@genesiscz/utils/cli/commander";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { Command } from "commander";
import { registerAuditCommands } from "./commands/audit";
import { registerProfileCommands } from "./commands/profiles";
import { refuseRootFlagsBeforeSubcommand, registerRemoveCommand } from "./commands/remove";
import { registerRequestCommands } from "./commands/requests";
import { registerRootCommands } from "./commands/roots";
import { registerSettingsCommands } from "./commands/settings";
import { registerTrashCommands } from "./commands/trash";

/** Gives every subcommand (and theirs) the global -v, which positional options would otherwise keep at the root. */
function addVerboseDeep(command: Command): void {
    for (const sub of command.commands) {
        addGlobalVerboseOption(sub);
        addVerboseDeep(sub);
    }
}

/**
 * The tools rm program. A root flag counts only before the subcommand name (positional options), so
 * `preset ... -n` and `requests --json` reach their own subcommand; Commander gave them to the root before.
 */
export function createRmProgram(): Command {
    const program = new Command();

    program
        .name(`${toolCommand("rm")}`)
        .description(
            "Safe delete for agents and people: presets for build output, the session's own files, trusted roots, " +
                "a request the user confirms for anything else; items move to a trash that drains in the background"
        )
        .enablePositionalOptions();

    registerRemoveCommand(program);
    registerSettingsCommands(program);
    registerRequestCommands(program);
    registerRootCommands(program);
    registerTrashCommands(program);
    registerProfileCommands(program);
    registerAuditCommands(program);
    addVerboseDeep(program);
    refuseRootFlagsBeforeSubcommand(program);
    return program;
}

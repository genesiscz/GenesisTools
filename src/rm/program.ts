import { lstatSync } from "node:fs";
import { join } from "node:path";
import { addGlobalVerboseOption } from "@genesiscz/utils/cli/commander";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { out } from "@genesiscz/utils/logger";
import { Command } from "commander";
import pc from "picocolors";
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
    noteFileNamedLikeSubcommand(program);
    program.addHelpText(
        "after",
        `\nA file named like a subcommand (log, trash, requests, prune, ...): delete it as ${toolCommand("rm")} ./log. ` +
            `${toolCommand("rm")} -- log still runs the log subcommand.`
    );
    return program;
}

/**
 * `tools rm log` lists the audit log also when the agent meant the file `./log`: the run exits 0, and the agent may
 * believe the file is gone. When a file (or a symlink) with the subcommand's name sits in the current folder, stderr
 * says how to delete it instead. A folder of that name gets no note: in `~/.genesis-tools/rm` the `requests` folder
 * is the request store, and in `src/` the `config` folder is a tool.
 */
function noteFileNamedLikeSubcommand(program: Command): void {
    program.hook("preSubcommand", (_root, sub) => {
        const name = sub.name();
        const entry = lstatSync(join(process.cwd(), name), { throwIfNoEntry: false });

        if (entry && (entry.isFile() || entry.isSymbolicLink())) {
            out.printlnErr(
                pc.dim(
                    `${name} here is a file; to delete it instead of running the ${name} subcommand, write ${toolCommand("rm")} ./${name}`
                )
            );
        }
    });
}

import { resolveRecording } from "@app/recorder/lib/library";
import { trashRecordings } from "@app/recorder/lib/quick-actions";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";

export function register(program: Command): void {
    program
        .command("trash")
        .description(
            `Move library recordings through the removal policy into the GenesisTools trash, all in one call; the answer names the batch, when it drains and the ${toolCommand("rm restore")} command that puts it back (${toolCommand("rm trash")} lists it too; the window's Move to Trash uses Finder's Trash). Run by an agent, or for a recording the policy does not allow, it asks the user: every such recording goes into ONE request they confirm with ${toolCommand("rm approve")} <id>. A meeting's screen recording is refused, and then nothing is moved`
        )
        .argument("<recording...>", "library ids, `last` or recording folders")
        .option("--no-aside", "keep the folders in the library while a request waits, instead of moving them aside")
        .action(async (values: string[], opts: { aside: boolean }) => {
            try {
                const folders = values.map((value) => resolveRecording(value));
                // RC24: one call per recording made one request each; one tools rm call makes at most one.
                out.result(await trashRecordings(folders, { askUser: true, ...(opts.aside ? {} : { aside: false }) }));
            } catch (error) {
                out.printlnErr(error instanceof Error ? error.message : String(error));
                process.exitCode = 1;
            }
        });
}

import { fetchCmuxTree } from "@genesiscz/utils/cmux/tree";
import { printCmuxTree } from "@genesiscz/utils/cmux/tree-print";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";

/** `tools cmux tree`: the live window → workspace → pane → surface hierarchy with pane frames, no agents. */
export function registerTreeCommand(program: Command): void {
    program
        .command("tree")
        .description("Live window → workspace → pane → surface hierarchy with pane frames (no agent sessions)")
        .option("--json", "Emit the tree as JSON instead of an indented listing")
        .action(async (opts: { json?: boolean }) => {
            const tree = await fetchCmuxTree();

            if (!tree.available) {
                process.exitCode = 1;
            }

            if (opts.json) {
                out.result(tree);
                return;
            }

            printCmuxTree(tree);
        });
}

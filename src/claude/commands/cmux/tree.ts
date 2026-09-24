import { fetchCmuxTree } from "@app/claude/lib/cmux/tree";
import { printCmuxTree } from "@genesiscz/utils/cmux/tree-print";
import { out } from "@genesiscz/utils/logger";

export interface TreeOptions {
    json?: boolean;
}

/** `tools claude cmux tree` — the live window → workspace → pane → surface hierarchy. */
export async function treeCommand(opts: TreeOptions): Promise<void> {
    const tree = await fetchCmuxTree();

    // focus exits 1 for the same outage; a pipeline must not read "cmux is down"
    // as success just because the human renderer printed the reason to stderr.
    if (!tree.available) {
        process.exitCode = 1;
    }

    if (opts.json) {
        out.result(tree);
        return;
    }

    printCmuxTree(tree);
}

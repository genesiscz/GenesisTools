import type { AccountProviderAlias } from "@genesiscz/utils/ai/providers/alias-list";
import { suggestEnumFlag } from "@genesiscz/utils/cli";
import { fetchAgentCmuxTree } from "@genesiscz/utils/cmux/agent-tree";
import { printCmuxTree } from "@genesiscz/utils/cmux/tree-print";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";

const AGENTS: readonly AccountProviderAlias[] = ["claude", "codex", "grok"];

function isAgent(name: string): name is AccountProviderAlias {
    return AGENTS.some((agent) => agent === name);
}

/** `tools ai cmux tree`: the cmux tree with the Claude, Codex and Grok session in each surface. */
export function registerCmuxCommands(program: Command): void {
    const cmux = program.command("cmux").description("cmux views across every coding agent");

    cmux.command("tree")
        .description("Live cmux hierarchy with each surface's agent session (Claude, Codex, Grok) and pane frames")
        .option("--json", "Emit the tree as JSON instead of an indented listing")
        .option("--provider [list]", "Only these agents, comma-separated: claude,codex,grok")
        .action(async (opts: { json?: boolean; provider?: string | boolean }) => {
            let providers: AccountProviderAlias[] | undefined;

            if (opts.provider !== undefined) {
                const wanted =
                    typeof opts.provider === "string" ? opts.provider.split(",").map((part) => part.trim()) : [];
                const unknown = wanted.filter((name) => !isAgent(name));

                if (wanted.length === 0 || unknown.length > 0) {
                    out.printlnErr(suggestEnumFlag("tools ai cmux tree", "--provider", AGENTS));
                    process.exitCode = 1;
                    return;
                }

                providers = AGENTS.filter((agent) => wanted.includes(agent));
            }

            const tree = await fetchAgentCmuxTree({ providers });

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

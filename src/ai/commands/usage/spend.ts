import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import type { Command } from "commander";

const DESCRIPTION = `Coding-agent token and cost analytics (alias of \`${toolCommand("ai-spend")}\`)`;

/**
 * `tools ai usage spend ...` is an alias of `tools ai-spend ...`: the same commander tree, registered by the same
 * function, so every verb prints the same bytes (`src/ai-spend/golden.test.ts`), and `tools ai-spend` stays the real,
 * documented path (design 2026-11-01, step U8). New spend verbs are added to the `tools ai-spend` tree and appear
 * here by themselves.
 *
 * The tree costs about 170 ms to import, so it loads only when argv asks for `usage spend`; any other `tools ai usage`
 * call registers the bare command with its description, which is all its help prints.
 */
export async function loadUsageSpendAlias(argv: readonly string[]): Promise<(usage: Command) => void> {
    const node = (usage: Command): Command => usage.command("spend").description(DESCRIPTION);

    if (!requestsSpend(argv)) {
        return (usage) => {
            node(usage);
        };
    }

    const { registerSpendCommand } = await import("@app/ai-spend/lib/register");

    return (usage) => {
        registerSpendCommand(node(usage));
    };
}

/**
 * True when a `spend` word follows `usage`. A flag value that happens to be `spend` loads the tree for nothing, which
 * costs time only; skipping flags by guesswork could miss `tools ai usage --json spend daily` and leave a bare node.
 */
function requestsSpend(argv: readonly string[]): boolean {
    const usageAt = argv.indexOf("usage", 2);

    return usageAt >= 0 && argv.slice(usageAt + 1).includes("spend");
}

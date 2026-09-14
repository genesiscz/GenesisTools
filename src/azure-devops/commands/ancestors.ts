import { Api } from "@app/azure-devops/api";
import { type WorkItemNode, walkAncestors } from "@app/azure-devops/lib/ancestors";
import { parseRelations } from "@app/azure-devops/relations";
import { requireConfig } from "@app/azure-devops/utils";
import { suggestEnumFlag } from "@genesiscz/utils/cli";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import pc from "picocolors";

const ANCESTOR_FORMATS = ["table", "json"] as const;

export function registerAncestorsCommand(parent: Command): void {
    parent
        .command("ancestors")
        .description("Walk a work item's parent chain upwards")
        .argument("<id>", "Work item ID")
        .option("--depth <n>", "Cap the climb at n ancestors above the item (default: climb to the root)")
        .option("--format <format>", "Output format: table|json", "table")
        .action(async (idArg: string, options: { depth?: string; format: string }) => {
            const config = requireConfig();
            const api = new Api(config);
            // `Number.parseInt` stops at the first non-digit, so `123abc` passed this guard as 123
            // and the command answered for a work item nobody asked about. Same fix as tree.ts.
            const id = Number(idArg);

            if (!Number.isInteger(id) || id < 1) {
                out.error(`Invalid work item id '${idArg}': expected a positive whole number`);
                process.exit(1);
            }

            if (!ANCESTOR_FORMATS.some((format) => format === options.format)) {
                out.error(
                    suggestEnumFlag("tools azure-devops ancestors", "--format", ANCESTOR_FORMATS, {
                        subcommand: ["ancestors"],
                        given: options.format,
                    })
                );
                process.exitCode = 1;
                return;
            }

            // `Number.parseInt` stops at the first non-digit, so `--depth 3x` passed the check
            // below as 3 while its message promises a whole number. `Number("")` coerces to 0,
            // which the `< 0` bound below would accept as a real depth, so an empty or
            // whitespace-only value is forced to NaN instead of silently becoming "climb none".
            const maxDepth =
                options.depth === undefined
                    ? undefined
                    : options.depth.trim() === ""
                      ? Number.NaN
                      : Number(options.depth);

            if (maxDepth !== undefined && (!Number.isInteger(maxDepth) || maxDepth < 0)) {
                out.error(`Invalid --depth '${options.depth}': expected a non-negative whole number`);
                process.exit(1);
            }

            const chain = await walkAncestors({
                id,
                maxDepth,
                fetch: async (workItemId): Promise<WorkItemNode | null> => {
                    try {
                        // `getWorkItem` also fetches the item's comments, over a request of their
                        // own, and nothing below reads them. That is one wasted request per
                        // ancestor, and the climb now runs to the root.
                        const items = await api.getWorkItems([workItemId], { comments: false });
                        const item = items.get(workItemId);

                        if (!item) {
                            return null;
                        }

                        return {
                            id: item.id,
                            title: item.title,
                            type: String(item.rawFields?.["System.WorkItemType"] ?? "?"),
                            parent: parseRelations(item.relations ?? []).parent,
                        };
                    } catch (err) {
                        // Only an ancestor may be swallowed: a truncated chain is still an answer.
                        // Swallowing the item the user asked for turns an auth or transport failure
                        // into "work item not found", which sends them hunting the wrong problem.
                        if (workItemId === id) {
                            throw err;
                        }

                        logFetchFailure(workItemId, err);

                        return null;
                    }
                },
            });

            if (chain.length === 0) {
                out.error(`Work item #${id} not found`);
                process.exit(1);
            }

            if (options.format === "json") {
                out.result(chain);
                return;
            }

            chain.forEach((node, index) => {
                const arrow = index === 0 ? "" : `${"  ".repeat(index)}${pc.dim("└─ ")}`;
                out.println(`${arrow}${pc.white(`#${node.id}`)} ${pc.dim(`[${node.type}]`)} ${node.title}`);
            });
        });
}

function logFetchFailure(workItemId: number, err: unknown): void {
    out.warn(pc.yellow(`  Could not read #${workItemId}: ${err instanceof Error ? err.message : String(err)}`));
}

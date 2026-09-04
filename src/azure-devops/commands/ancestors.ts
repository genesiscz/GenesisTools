import { Api } from "@app/azure-devops/api";
import { type WorkItemNode, walkAncestors } from "@app/azure-devops/lib/ancestors";
import { parseRelations } from "@app/azure-devops/relations";
import { requireConfig } from "@app/azure-devops/utils";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import pc from "picocolors";

export function registerAncestorsCommand(parent: Command): void {
    parent
        .command("ancestors")
        .description("Walk a work item's parent chain upwards")
        .argument("<id>", "Work item ID")
        .option("--depth <n>", "How many ancestors above the item to climb", "3")
        .option("--format <format>", "Output format: table|json", "table")
        .action(async (idArg: string, options: { depth: string; format: string }) => {
            const config = requireConfig();
            const api = new Api(config);
            const id = Number.parseInt(idArg, 10);

            if (Number.isNaN(id)) {
                out.error(`Invalid work item id '${idArg}'`);
                process.exit(1);
            }

            const maxDepth = Number.parseInt(options.depth, 10);

            if (!Number.isInteger(maxDepth) || maxDepth < 0) {
                out.error(`Invalid --depth '${options.depth}': expected a non-negative whole number`);
                process.exit(1);
            }

            const chain = await walkAncestors({
                id,
                maxDepth,
                fetch: async (workItemId): Promise<WorkItemNode | null> => {
                    try {
                        const item = await api.getWorkItem(workItemId);

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

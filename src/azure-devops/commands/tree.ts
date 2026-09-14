import { Api } from "@app/azure-devops/api";
import { isLinksFresh, loadWorkItemCache, updateWorkItemCacheSection } from "@app/azure-devops/cache";
import { buildWorkItemTree } from "@app/azure-devops/lib/tree";
import { parseRelations } from "@app/azure-devops/relations";
import type { AdoTaskSimple, WorkItemFull, WorkItemLinks, WorkItemLinksSection } from "@app/azure-devops/types";
import { requireConfig } from "@app/azure-devops/utils";
import { concurrentMap } from "@genesiscz/utils/async";
import { suggestEnumFlag } from "@genesiscz/utils/cli";
import { logger, out } from "@genesiscz/utils/logger";
import { createBoxTable, renderCliHeader, truncateDisplay } from "@genesiscz/utils/table";
import type { Command } from "commander";
import pc from "picocolors";

const TREE_FORMATS = ["table", "json"] as const;

export function registerTreeCommand(parent: Command): void {
    parent
        .command("tree")
        .description("Show a work item's neighbourhood: every parent up the chain, every child, every related item")
        .argument("<id>", "Work item ID")
        .option("--force", "Refetch every work item instead of reading the cache")
        .option("--format <format>", "Output format: table|json", "table")
        .action(async (idArg: string, options: { force?: boolean; format: string }) => {
            const config = requireConfig();
            const api = new Api(config);
            // `Number.parseInt` stops at the first non-digit, so `123abc` passed this guard as 123
            // and the command answered for a work item nobody asked about.
            const id = Number(idArg);

            if (!Number.isInteger(id) || id < 1) {
                out.error(`Invalid work item id '${idArg}': expected a positive whole number`);
                process.exitCode = 1;
                return;
            }

            // An unknown --format used to fall through to the table, so a typo answered in a shape
            // the caller did not ask for and a script parsing JSON got a box-drawn table instead.
            if (!TREE_FORMATS.some((format) => format === options.format)) {
                out.error(
                    suggestEnumFlag("tools azure-devops tree", "--format", TREE_FORMATS, {
                        subcommand: ["tree"],
                        given: options.format,
                    })
                );
                process.exitCode = 1;
                return;
            }

            const tree = await buildWorkItemTree({
                id,
                fetchMany: (ids) => resolveLinks({ ids, api, force: options.force === true }),
            });

            if (!tree) {
                out.error(`Work item #${id} not found`);
                process.exitCode = 1;
                return;
            }

            if (options.format === "json") {
                out.result(tree);
                return;
            }

            renderTree(tree);
        });
}

/**
 * Answer from the link cache where it is fresh and fetch only the rest, so a repeated `tree` of the
 * same work item inside the five-minute freshness window costs no HTTP call. `--force` skips the
 * cache the way `workitem --force`
 * does. Every fetched item is written back, including the neighbours, because they are the ids the
 * next run asks about.
 */
async function resolveLinks({
    ids,
    api,
    force,
}: {
    ids: number[];
    api: Api;
    force: boolean;
}): Promise<Map<number, WorkItemLinks>> {
    const resolved = new Map<number, WorkItemLinks>();
    const needsFetch: number[] = [];

    // A work item with a long child list turned this into that many sequential file reads. The
    // concurrency stays bounded rather than one Promise.all over every id, because a wide level
    // would otherwise open a file handle per child at once.
    const cached = force
        ? new Map<number, Awaited<ReturnType<typeof loadWorkItemCache>>>()
        : await concurrentMap({ items: ids, fn: loadWorkItemCache, concurrency: 8 });

    for (const id of ids) {
        const entry = cached.get(id);

        if (entry?.links && isLinksFresh(entry)) {
            logger.debug(`[tree] #${id} answered from the link cache`);
            resolved.set(id, { id, ...entry.links });
            continue;
        }

        needsFetch.push(id);
    }

    if (needsFetch.length === 0) {
        return resolved;
    }

    logger.debug(`[tree] fetching ${needsFetch.length} work item(s): ${needsFetch.join(", ")}`);
    const fetched = await api.getWorkItems(needsFetch, { comments: false });
    const sections = new Map<number, WorkItemLinksSection>();

    for (const [itemId, item] of fetched) {
        const section = toLinksSection(item);
        sections.set(itemId, section);
        resolved.set(itemId, { id: itemId, ...section });
    }

    // Each work item is its own cache file with its own lock, so the writebacks do not contend.
    await concurrentMap({
        items: [...sections.keys()],
        fn: (itemId) => updateWorkItemCacheSection(itemId, { links: sections.get(itemId) }),
        concurrency: 8,
        onError: (itemId, error) => logger.warn(`[tree] could not cache the links of #${itemId}: ${error}`),
    });

    return resolved;
}

function toLinksSection(item: WorkItemFull): WorkItemLinksSection {
    const relations = parseRelations(item.relations ?? []);

    return {
        title: item.title,
        type: String(item.rawFields?.["System.WorkItemType"] ?? "?"),
        assignedTo: item.assignee ?? null,
        createdAt: item.created ?? null,
        updatedAt: item.changed ?? null,
        parentId: relations.parent,
        childIds: relations.children,
        relatedIds: relations.related,
    };
}

function renderTree(tree: AdoTaskSimple): void {
    renderCliHeader(`#${tree.adoID} [${tree.type}]`, tree.title);

    const table = createBoxTable(["RELATION", "ID", "TYPE", "TITLE", "ASSIGNED TO"]);

    tree.parent.forEach((node, index) => {
        table.push(linkRow(index === 0 ? "parent" : `parent ↑${index + 1}`, node));
    });

    for (const node of tree.children) {
        table.push(linkRow("child", node));
    }

    for (const node of tree.related) {
        table.push(linkRow("related", node));
    }

    if (table.length === 0) {
        out.println(pc.dim("  No parent, child or related work item."));
        return;
    }

    out.println(table.toString());
    out.println(
        pc.dim(
            `  ${tree.parent.length} parent(s) · ${tree.children.length} child(ren) · ${tree.related.length} related`
        )
    );
}

function linkRow(relation: string, node: AdoTaskSimple): string[] {
    return [
        pc.dim(relation),
        pc.white(`#${node.adoID}`),
        node.type,
        truncateDisplay(node.title, 50),
        truncateDisplay(node.assignedTo, 22),
    ];
}

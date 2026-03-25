import * as p from "@clack/prompts";
import pc from "picocolors";
import type { IndexerManager } from "./manager";

interface RemoveWorkflowOptions {
    manager: IndexerManager;
    /** Pre-selected index name (from CLI positional arg) */
    name?: string;
    /** Skip confirmation prompts */
    force?: boolean;
}

/** Filter out internal companion indexes (e.g. `foo__context`) from user-facing lists */
function userFacingNames(allNames: string[]): string[] {
    return allNames.filter((n) => !n.endsWith("__context"));
}

/**
 * Run the remove workflow: select indexes, confirm, remove.
 * Returns the names that were actually removed.
 */
export async function removeWorkflow({ manager, name, force }: RemoveWorkflowOptions): Promise<string[]> {
    const allNames = manager.getIndexNames();
    const displayNames = userFacingNames(allNames);

    if (displayNames.length === 0) {
        p.log.info("No indexes to remove.");
        return [];
    }

    let toRemove: string[];

    if (name) {
        if (!allNames.includes(name)) {
            p.log.error(`Index "${name}" not found. Available: ${displayNames.join(", ")}`);
            process.exit(1);
        }

        toRemove = [name];
    } else {
        if (!process.stdout.isTTY || !process.stdin.isTTY) {
            p.log.error("Specify an index name in non-interactive mode:");
            p.log.info(`  Available: ${displayNames.join(", ")}`);
            p.log.info("  Usage: tools indexer remove <name> [--force]");
            process.exit(1);
        }

        const selected = await p.multiselect({
            message: "Select indexes to remove",
            options: displayNames.map((n) => ({ value: n, label: n })),
            required: true,
        });

        if (p.isCancel(selected)) {
            p.log.info("Cancelled");
            return [];
        }

        toRemove = selected as string[];
    }

    if (toRemove.length === 0) {
        p.log.info("Nothing selected.");
        return [];
    }

    const removed: string[] = [];

    for (const indexName of toRemove) {
        if (!force) {
            if (!process.stdout.isTTY || !process.stdin.isTTY) {
                p.log.error("Use --force in non-interactive mode");
                process.exit(1);
            }

            const confirmed = await p.confirm({
                message: `Remove "${pc.bold(indexName)}" and all its data?`,
            });

            if (p.isCancel(confirmed) || !confirmed) {
                p.log.info(`Skipped "${indexName}"`);
                continue;
            }
        }

        await manager.removeIndex(indexName);
        p.log.success(`Removed "${pc.bold(indexName)}"`);
        removed.push(indexName);
    }

    return removed;
}

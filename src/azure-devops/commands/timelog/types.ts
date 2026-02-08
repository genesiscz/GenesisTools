import { Command } from "commander";
import { requireTimeLogConfig, requireTimeLogUser } from "@app/azure-devops/utils";
import { TimeLogApi } from "@app/azure-devops/timelog-api";
import { loadTimeTypesCache, saveTimeTypesCache } from "@app/azure-devops/cache";
import logger from "@app/logger";
import type { TimeType } from "@app/azure-devops/types";

export function registerTypesSubcommand(parent: Command): void {
    parent
        .command("types")
        .description("List available time types")
        .option("--force", "Bypass cache")
        .option("--format <format>", "Output format: ai|json", "ai")
        .action(async (options: { force?: boolean; format?: string }) => {
            const config = requireTimeLogConfig();
            const user = requireTimeLogUser(config);

            // Check cache first
            let types: TimeType[] | null = null;

            if (!options.force) {
                types = await loadTimeTypesCache(config.projectId);

                if (types) {
                    logger.debug("[timelog] Using cached time types");
                }
            }

            // Fetch from API if needed
            if (!types) {
                const api = new TimeLogApi(config.orgId!, config.projectId, config.timelog!.functionsKey, user);
                types = await api.getTimeTypes();
                await saveTimeTypesCache(config.projectId, types);
            }

            // Output
            if (options.format === "json") {
                console.log(JSON.stringify(types, null, 2));
                return;
            }

            // AI-friendly format
            console.log("Available Time Types:");
            console.log("=====================");

            for (const type of types) {
                const defaultMark = type.isDefaultForProject ? " (default)" : "";
                console.log(`  - ${type.description}${defaultMark}`);
            }

            console.log(`\nTotal: ${types.length} time types`);
        });
}

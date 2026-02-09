import { Command } from "commander";
import { existsSync, readFileSync } from "fs";
import pc from "picocolors";
import { requireTimeLogConfig, requireTimeLogUser } from "@app/azure-devops/utils";
import { TimeLogApi, formatMinutes, convertToMinutes } from "@app/azure-devops/timelog-api";
import { precheckWorkItem } from "@app/azure-devops/workitem-precheck";
import { AzureDevOpsCacheManager } from "@app/azure-devops/cache-manager";
import type { TimeLogImportFile, AllowedTypeConfig } from "@app/azure-devops/types";
import logger from "@app/logger";

export function registerImportSubcommand(parent: Command): void {
    parent
        .command("import")
        .description("Import time logs from JSON file")
        .argument("<file>", "JSON file path")
        .option("--dry-run", "Validate without creating entries")
        .action(async (file: string, options: { dryRun?: boolean }) => {
            const config = requireTimeLogConfig();
            const user = requireTimeLogUser(config);

            if (!existsSync(file)) {
                console.error(`File not found: ${file}`);
                process.exit(1);
            }

            let data: TimeLogImportFile;

            try {
                const content = readFileSync(file, "utf-8");
                data = JSON.parse(content);
            } catch (e) {
                console.error(`Invalid JSON: ${(e as Error).message}`);
                process.exit(1);
            }

            if (!data.entries || !Array.isArray(data.entries)) {
                console.error(`Invalid format: expected { entries: [...] }`);
                process.exit(1);
            }

            const api = new TimeLogApi(config.orgId!, config.projectId, config.timelog!.functionsKey, user);

            // Validate time types
            const types = await api.getTimeTypes();
            const typeNames = new Set(types.map((t) => t.description.toLowerCase()));

            const errors: string[] = [];
            const validEntries: Array<{
                workItemId: number;
                minutes: number;
                timeType: string;
                date: string;
                comment: string;
            }> = [];

            for (let i = 0; i < data.entries.length; i++) {
                const entry = data.entries[i];
                const idx = i + 1;

                // Validate work item ID
                if (!entry.workItemId || isNaN(entry.workItemId)) {
                    errors.push(`Entry ${idx}: Missing or invalid workItemId`);
                    continue;
                }

                // Validate time
                let minutes: number;

                try {
                    minutes = convertToMinutes(entry.hours, entry.minutes);
                } catch (e) {
                    errors.push(`Entry ${idx}: ${(e as Error).message}`);
                    continue;
                }

                // Validate time type
                if (!entry.timeType) {
                    errors.push(`Entry ${idx}: Missing timeType`);
                    continue;
                }

                if (!typeNames.has(entry.timeType.toLowerCase())) {
                    errors.push(`Entry ${idx}: Unknown time type "${entry.timeType}"`);
                    continue;
                }

                // Validate date
                if (!entry.date || !/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) {
                    errors.push(`Entry ${idx}: Invalid date format (use YYYY-MM-DD)`);
                    continue;
                }

                // Find exact type name (case-sensitive from API)
                const exactType = types.find((t) => t.description.toLowerCase() === entry.timeType.toLowerCase());

                validEntries.push({
                    workItemId: entry.workItemId,
                    minutes,
                    timeType: exactType!.description,
                    date: entry.date,
                    comment: entry.comment || "",
                });
            }

            // Report validation errors
            if (errors.length > 0) {
                console.error("Validation errors:");

                for (const err of errors) {
                    console.error(`  - ${err}`);
                }

                if (validEntries.length === 0) {
                    process.exit(1);
                }

                console.log(`\n${validEntries.length} entries are valid.\n`);
            }

            // ---- Precheck phase: validate work item types ----
            const allowedTypeConfig: AllowedTypeConfig | undefined = config.timelog!.allowedWorkItemTypes?.length
                ? {
                      allowedWorkItemTypes: config.timelog!.allowedWorkItemTypes,
                      allowedStatesPerType: config.timelog!.allowedStatesPerType,
                      deprioritizedStates: config.timelog!.deprioritizedStates,
                      defaultUserName: config.timelog!.defaultUser?.userName,
                  }
                : undefined;

            let precheckPassed: typeof validEntries = [];
            const precheckRedirected: Array<{ original: number; redirected: number; type: string }> = [];
            const precheckFailed: string[] = [];

            if (!allowedTypeConfig) {
                logger.debug("[import] allowedWorkItemTypes not configured, skipping precheck");
                console.log(
                    pc.yellow("Note: allowedWorkItemTypes not configured — skipping work item type precheck.\n")
                );
                precheckPassed = validEntries;
            } else {
                console.log("Pre-checking work item types...");

                // Deduplicate work item IDs to avoid redundant API calls
                const uniqueWorkItemIds = [...new Set(validEntries.map((e) => e.workItemId))];
                const precheckResults = new Map<number, Awaited<ReturnType<typeof precheckWorkItem>>>();

                for (const workItemId of uniqueWorkItemIds) {
                    const result = await precheckWorkItem(workItemId, config.org, allowedTypeConfig);
                    precheckResults.set(workItemId, result);
                }

                for (const entry of validEntries) {
                    const result = precheckResults.get(entry.workItemId)!;

                    if (result.status === "ok") {
                        precheckPassed.push(entry);
                    } else if (result.status === "redirect") {
                        const redirectedEntry = { ...entry, workItemId: result.redirectId! };
                        precheckPassed.push(redirectedEntry);
                        precheckRedirected.push({
                            original: entry.workItemId,
                            redirected: result.redirectId!,
                            type: `${result.originalType} -> ${result.redirectType}`,
                        });
                    } else {
                        precheckFailed.push(`#${entry.workItemId}: ${result.message}`);
                    }
                }

                // Show precheck summary
                console.log("\nPre-check results:");

                if (precheckPassed.length - precheckRedirected.length > 0) {
                    console.log(
                        pc.green(`  \u2714 ${precheckPassed.length - precheckRedirected.length} entries passed`)
                    );
                }

                if (precheckRedirected.length > 0) {
                    console.log(pc.yellow(`  \u26A0 ${precheckRedirected.length} entries redirected`));

                    for (const r of precheckRedirected) {
                        console.log(pc.dim(`    #${r.original} -> #${r.redirected} (${r.type})`));
                    }
                }

                if (precheckFailed.length > 0) {
                    console.log(pc.red(`  \u2716 ${precheckFailed.length} entries failed`));

                    for (const f of precheckFailed) {
                        console.log(pc.dim(`    ${f}`));
                    }
                }

                console.log();

                if (precheckPassed.length === 0) {
                    console.error("No entries passed precheck. Aborting.");
                    process.exit(1);
                }
            }

            if (options.dryRun) {
                console.log("\u2714 Dry run complete. Valid entries:");

                for (const e of precheckPassed) {
                    console.log(`  #${e.workItemId}: ${formatMinutes(e.minutes)} ${e.timeType} on ${e.date}`);
                }

                return;
            }

            // Create entries
            console.log(`Creating ${precheckPassed.length} time log entries...`);
            let created = 0;
            const failed: string[] = [];
            const createdWorkItemIds: number[] = [];

            for (const entry of precheckPassed) {
                try {
                    const ids = await api.createTimeLogEntry(
                        entry.workItemId,
                        entry.minutes,
                        entry.timeType,
                        entry.date,
                        entry.comment
                    );
                    created++;
                    createdWorkItemIds.push(entry.workItemId);
                    const parts = [`#${entry.workItemId}`, formatMinutes(entry.minutes), entry.timeType, entry.date];

                    if (entry.comment) {
                        parts.push(entry.comment);
                    }

                    parts.push(`[${ids[0].substring(0, 8)}]`);
                    console.log(`  \u2714 ${parts.join(" | ")}`);
                } catch (e) {
                    failed.push(`#${entry.workItemId}: ${(e as Error).message}`);
                }
            }

            console.log(`\n\u2714 Created ${created}/${precheckPassed.length} entries`);

            if (failed.length > 0) {
                console.error("\nFailed:");

                for (const f of failed) {
                    console.error(`  - ${f}`);
                }
            }

            // Evict timelog cache for affected work items
            if (createdWorkItemIds.length > 0) {
                const cacheManager = new AzureDevOpsCacheManager();
                const uniqueCreatedIds = [...new Set(createdWorkItemIds)];
                cacheManager.onTimelogCreated(uniqueCreatedIds).catch((err) => {
                    logger.debug(`[import] Cache eviction failed: ${err}`);
                });
            }
        });
}

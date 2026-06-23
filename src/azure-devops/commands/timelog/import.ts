import { existsSync, readFileSync } from "node:fs";
import { Api } from "@app/azure-devops/api";
import { AzureDevOpsCacheManager } from "@app/azure-devops/cache-manager";
import { buildAllowedTypeConfig } from "@app/azure-devops/lib/timelog/allowed-type-config";
import {
    normalizeTimelogEntries,
    readEntryWorkItemTitle,
    setEntryWorkItemTitle,
} from "@app/azure-devops/lib/timelog/entry-fields";
import { convertToMinutes, formatMinutes, TimeLogApi } from "@app/azure-devops/timelog-api";
import { updateWorkItemEffort } from "@app/azure-devops/timelog-effort";
import type { TimeLogImportFile } from "@app/azure-devops/types";
import { requireTimeLogConfig, requireTimeLogUser } from "@app/azure-devops/utils";
import { precheckWorkItem } from "@app/azure-devops/workitem-precheck";
import { logger, out } from "@app/logger";
import { concurrentMap } from "@app/utils/async";
import { SafeJSON } from "@app/utils/json";
import type { Command } from "commander";
import pc from "picocolors";

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
                out.error(`File not found: ${file}`);
                process.exit(1);
            }

            let data: TimeLogImportFile;

            try {
                const content = readFileSync(file, "utf-8");
                data = SafeJSON.parse(content, { strict: true });
            } catch (e) {
                out.error(`Invalid JSON: ${(e as Error).message}`);
                process.exit(1);
            }

            if (!data.entries || !Array.isArray(data.entries)) {
                out.error(`Invalid format: expected { entries: [...] }`);
                process.exit(1);
            }

            const api = new TimeLogApi(config.orgId!, config.projectId, config.timelog!.functionsKey, user);

            // Validate time types
            const types = await api.getTimeTypes();
            const typeNames = new Set(types.map((t) => t.description.toLowerCase()));

            const errors: string[] = [];
            const validEntries: Array<{
                workItemId: number;
                workItemTitle?: string;
                minutes: number;
                timeType: string;
                date: string;
                comment: string;
            }> = [];

            for (let i = 0; i < data.entries.length; i++) {
                const entry = data.entries[i];
                const idx = i + 1;

                // Validate work item ID
                if (!entry.workItemId || Number.isNaN(entry.workItemId)) {
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
                    workItemTitle: readEntryWorkItemTitle(entry),
                    minutes,
                    timeType: exactType!.description,
                    date: entry.date,
                    comment: entry.comment || "",
                });
            }

            const workitemTitles = new Map<number, string>();

            // Report validation errors
            if (errors.length > 0) {
                out.error("Validation errors:");

                for (const err of errors) {
                    out.error(`  - ${err}`);
                }

                if (validEntries.length === 0) {
                    process.exit(1);
                }

                out.println(`\n${validEntries.length} entries are valid.\n`);
            }

            // ---- Precheck phase: validate work item types ----
            const allowedTypeConfig = buildAllowedTypeConfig(config);

            let precheckPassed: typeof validEntries = [];
            const precheckRedirected: Array<{
                original: number;
                originalTitle: string;
                originalType: string;
                redirected: number;
                redirectedTitle: string;
                redirectedType: string;
            }> = [];
            const precheckFailed: string[] = [];

            if (!allowedTypeConfig) {
                logger.debug("[import] allowedWorkItemTypes not configured, skipping precheck");
                out.println(
                    pc.yellow("Note: allowedWorkItemTypes not configured — skipping work item type precheck.\n")
                );
                precheckPassed = validEntries;

                for (const entry of validEntries) {
                    if (entry.workItemTitle) {
                        workitemTitles.set(entry.workItemId, entry.workItemTitle);
                    }
                }
            } else {
                out.println("Pre-checking work item types...");

                // Deduplicate work item IDs to avoid redundant API calls
                const uniqueWorkItemIds = [...new Set(validEntries.map((e) => e.workItemId))];
                const precheckResults = await concurrentMap({
                    items: uniqueWorkItemIds,
                    fn: (workItemId) => precheckWorkItem(workItemId, config.org, allowedTypeConfig),
                    concurrency: 5,
                });

                for (const entry of validEntries) {
                    const result = precheckResults.get(entry.workItemId)!;

                    if (result.status === "ok") {
                        precheckPassed.push(entry);
                    } else if (result.status === "redirect") {
                        const redirectedEntry = { ...entry, workItemId: result.redirectId! };
                        precheckPassed.push(redirectedEntry);
                        precheckRedirected.push({
                            original: entry.workItemId,
                            originalTitle: result.originalTitle,
                            originalType: result.originalType,
                            redirected: result.redirectId!,
                            redirectedTitle: result.redirectTitle!,
                            redirectedType: result.redirectType!,
                        });
                    } else {
                        precheckFailed.push(`#${entry.workItemId}: ${result.message}`);
                    }
                }

                // Show precheck summary
                out.println("\nPre-check results:");

                if (precheckPassed.length - precheckRedirected.length > 0) {
                    out.println(
                        pc.green(`  \u2714 ${precheckPassed.length - precheckRedirected.length} entries passed`)
                    );
                }

                if (precheckRedirected.length > 0) {
                    out.println(pc.yellow(`  \u26A0 ${precheckRedirected.length} entries redirected`));

                    for (const r of precheckRedirected) {
                        out.println(
                            pc.dim(
                                `    #${r.original} ${r.originalTitle} (${r.originalType}) -> #${r.redirected} ${r.redirectedTitle} (${r.redirectedType})`
                            )
                        );
                    }
                }

                if (precheckFailed.length > 0) {
                    out.println(pc.red(`  \u2716 ${precheckFailed.length} entries failed`));

                    for (const f of precheckFailed) {
                        out.println(pc.dim(`    ${f}`));
                    }
                }

                // Build workitem title lookup from precheck results
                for (const [id, result] of precheckResults) {
                    workitemTitles.set(id, result.originalTitle);

                    if (result.redirectId && result.redirectTitle) {
                        workitemTitles.set(result.redirectId, result.redirectTitle);
                    }
                }

                out.println();

                if (precheckPassed.length === 0) {
                    out.error("No entries passed precheck. Aborting.");
                    process.exit(1);
                }
            }

            if (options.dryRun) {
                const serializedBefore = SafeJSON.stringify(data.entries, null, 2);
                data.entries = normalizeTimelogEntries(
                    data.entries.map((entry) => {
                        const title = workitemTitles.get(entry.workItemId) ?? readEntryWorkItemTitle(entry);

                        if (title) {
                            return setEntryWorkItemTitle(entry, title);
                        }

                        return entry;
                    })
                );
                const serializedAfter = SafeJSON.stringify(data.entries, null, 2);

                if (serializedBefore !== serializedAfter) {
                    await Bun.write(file, `${serializedAfter}\n`);
                    out.println(pc.dim(`Updated ${file} with resolved workItemTitle values.\n`));
                }

                out.println("\u2714 Dry run complete. Valid entries:");

                for (const e of precheckPassed) {
                    const title = workitemTitles.get(e.workItemId);
                    const titlePart = title ? ` ${title}` : "";
                    out.println(
                        `  #${e.workItemId}${titlePart}: ${formatMinutes(e.minutes)} ${e.timeType} on ${e.date}`
                    );
                }

                return;
            }

            // Create entries
            out.println(`Creating ${precheckPassed.length} time log entries...`);
            let created = 0;
            const failed: string[] = [];
            const createdWorkItemIds: number[] = [];
            const minutesPerWorkItem = new Map<number, number>();

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
                    minutesPerWorkItem.set(
                        entry.workItemId,
                        (minutesPerWorkItem.get(entry.workItemId) ?? 0) + entry.minutes
                    );
                    const title = workitemTitles.get(entry.workItemId);
                    const wiLabel = title ? `#${entry.workItemId} ${title}` : `#${entry.workItemId}`;
                    const parts = [wiLabel, formatMinutes(entry.minutes), entry.timeType, entry.date];

                    if (entry.comment) {
                        parts.push(entry.comment);
                    }

                    parts.push(`[${ids[0].substring(0, 8)}]`);
                    out.println(`  \u2714 ${parts.join(" | ")}`);
                } catch (e) {
                    failed.push(`#${entry.workItemId}: ${(e as Error).message}`);
                }
            }

            out.println(`\n\u2714 Created ${created}/${precheckPassed.length} entries`);

            if (failed.length > 0) {
                out.error("\nFailed:");

                for (const f of failed) {
                    out.error(`  - ${f}`);
                }
            }

            // Update Remaining/Completed Work on affected work items (one update per unique work item)
            if (minutesPerWorkItem.size > 0) {
                out.println("\nUpdating work item effort...");
                const devopsApi = new Api(config);

                for (const [workItemId, totalMins] of minutesPerWorkItem) {
                    const effort = await updateWorkItemEffort(devopsApi, workItemId, totalMins);

                    if (effort) {
                        out.println(
                            `  \u2714 #${workItemId}: Remaining ${effort.remaining}h | Completed ${effort.completed}h`
                        );
                    }
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

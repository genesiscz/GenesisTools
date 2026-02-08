import { Command } from "commander";
import { $ } from "bun";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { loadConfig, findConfigPath, requireTimeLogConfig, requireTimeLogUser } from "@app/azure-devops/utils";
import { TimeLogApi, formatMinutes, convertToMinutes, getTodayDate } from "@app/azure-devops/timelog-api";
import { loadTimeTypesCache, saveTimeTypesCache } from "@app/azure-devops/cache";
import { runInteractiveAddClack } from "@app/azure-devops/timelog-prompts-clack";
import { runInteractiveAddInquirer } from "@app/azure-devops/timelog-prompts-inquirer";
import pc from "picocolors";
import * as p from "@clack/prompts";
import Table from "cli-table3";
import logger from "@app/logger";
import type { AzureConfigWithTimeLog, TimeType, TimeLogUser, TimeLogImportFile } from "@app/azure-devops/types";

// Toggle between prompt implementations
// 1 = @clack/prompts (preferred)
// 0 = @inquirer/prompts (fallback)
const USE_CLACK = 1;

function collectUsers(value: string, previous: string[]): string[] {
    return previous.concat([value]);
}

async function runInteractiveAdd(
    config: AzureConfigWithTimeLog,
    user: TimeLogUser,
    prefilledWorkItem?: string
): Promise<void> {
    if (USE_CLACK) {
        await runInteractiveAddClack(config, user, prefilledWorkItem);
    } else {
        await runInteractiveAddInquirer(config, user, prefilledWorkItem);
    }
}

function showHelpFull(): void {
    console.log(`
Usage: tools azure-devops timelog <command> [options]

Commands:
  add      Add a time log entry to a work item
  list     List time logs (per work item or date range query)
  delete   Delete a time log entry by ID
  types    List available time types
  import   Import time logs from JSON file

Examples:
  tools azure-devops timelog add --workitem 268935 --hours 2 --type "Development"
  tools azure-devops timelog add --workitem 268935 --hours 1 --minutes 30 --type "Code Review" --comment "PR review"
  tools azure-devops timelog add --workitem 268935 --interactive
  tools azure-devops timelog list --workitem 268935
  tools azure-devops timelog list --day 2026-01-30
  tools azure-devops timelog list --since 2026-01-01 --upto 2026-01-31 --user "Martin"
  tools azure-devops timelog list --day 2026-01-30 --format table
  tools azure-devops timelog delete <timeLogId>
  tools azure-devops timelog delete --workitem 268935   (interactive picker)
  tools azure-devops timelog types
  tools azure-devops timelog import entries.json

Available Time Types (run 'timelog types' for full list):
  Development, Code Review, Business Analýza, IT Analýza, Test,
  Dokumentace, Ceremonie, Konfigurace, Release, UX, ...

Hours/Minutes:
  --hours 2              → 120 minutes
  --hours 1 --minutes 30 → 90 minutes
  --minutes 30           → ERROR (use --hours 0 --minutes 30)
  --hours 0 --minutes 30 → 30 minutes
`);
}

function showAddHelp(): void {
    console.log(`
Usage: tools azure-devops timelog add [options]

Required (unless -i):
  -w, --workitem <id>     Work item ID to log time against
  -h, --hours <number>    Hours to log (e.g., 2)
  -t, --type <name>       Time type (see 'timelog types' for list)

Optional:
  -m, --minutes <number>  Additional minutes (requires --hours to be set)
  -d, --date <YYYY-MM-DD> Date of the entry (default: today)
  -c, --comment <text>    Description of work performed
  -i, --interactive       Interactive mode with prompts

Note: If using only minutes, specify --hours 0 --minutes <n> to confirm intent.

Examples:
  tools azure-devops timelog add -w 268935 -h 2 -t "Development"
  tools azure-devops timelog add -w 268935 -h 1 -m 30 -t "Code Review" -c "PR review"
  tools azure-devops timelog add -w 268935 -h 0 -m 30 -t "Test" -d 2026-02-03
  tools azure-devops timelog add -i
  tools azure-devops timelog add -w 268935 -i
`);
}

export function registerTimelogCommand(program: Command): void {
    const timelog = program
        .command("timelog")
        .description("Manage time log entries")
        .option("-?, --help-full", "Show detailed help")
        .action((options) => {
            if (options.helpFull) {
                showHelpFull();
                process.exit(0);
            }
            // Show subcommands help if no subcommand given
            timelog.help();
        });

    timelog
        .command("add")
        .description("Add a time log entry")
        .option("-w, --workitem <id>", "Work item ID")
        .option("-h, --hours <hours>", "Hours to log")
        .option("-m, --minutes <minutes>", "Additional minutes (requires --hours)")
        .option("-t, --type <type>", 'Time type (e.g., "Development")')
        .option("-d, --date <date>", "Date (YYYY-MM-DD, default: today)")
        .option("-c, --comment <text>", "Comment/description")
        .option("-i, --interactive", "Interactive mode with prompts")
        .option("-?, --help-full", "Show detailed help")
        .action(
            async (options: {
                workitem?: string;
                hours?: string;
                minutes?: string;
                type?: string;
                date?: string;
                comment?: string;
                interactive?: boolean;
                helpFull?: boolean;
            }) => {
                if (options.helpFull) {
                    showAddHelp();
                    return;
                }

                const config = requireTimeLogConfig();
                const user = requireTimeLogUser(config);

                // Interactive mode
                if (options.interactive) {
                    await runInteractiveAdd(config, user, options.workitem);
                    return;
                }

                // Validate required fields
                if (!options.workitem || !options.hours || !options.type) {
                    console.error(`
❌ Missing required options for non-interactive mode.

Required: --workitem, --hours, --type

Examples:
  tools azure-devops timelog add -w 268935 -h 2 -t "Development"
  tools azure-devops timelog add -w 268935 -h 1 -m 30 -t "Code Review" -c "PR review"

Or use interactive mode:
  tools azure-devops timelog add -i
  tools azure-devops timelog add -w 268935 -i
`);
                    process.exit(1);
                }

                const workItemId = parseInt(options.workitem, 10);
                if (isNaN(workItemId)) {
                    console.error("❌ Invalid work item ID");
                    process.exit(1);
                }

                // Convert hours/minutes
                let totalMinutes: number;
                try {
                    totalMinutes = convertToMinutes(
                        options.hours ? parseFloat(options.hours) : undefined,
                        options.minutes ? parseInt(options.minutes, 10) : undefined
                    );
                } catch (e) {
                    console.error(`❌ ${(e as Error).message}`);
                    process.exit(1);
                }

                const api = new TimeLogApi(config.orgId!, config.projectId, config.timelog!.functionsKey, user);

                // Validate time type exists
                const validType = await api.validateTimeType(options.type);
                if (!validType) {
                    const types = await api.getTimeTypes();
                    console.error(`
❌ Unknown time type: "${options.type}"

Available types:
${types.map((t) => `  - ${t.description}`).join("\n")}
`);
                    process.exit(1);
                }

                const date = options.date || getTodayDate();
                const comment = options.comment || "";

                // Create the entry
                const ids = await api.createTimeLogEntry(
                    workItemId,
                    totalMinutes,
                    validType.description, // Use exact casing from API
                    date,
                    comment
                );

                console.log(`✔ Time logged successfully!`);
                console.log(`  Work Item: #${workItemId}`);
                console.log(`  Time: ${formatMinutes(totalMinutes)}`);
                console.log(`  Type: ${validType.description}`);
                console.log(`  Date: ${date}`);
                if (comment) console.log(`  Comment: ${comment}`);
                console.log(`  Entry ID: ${ids[0]}`);
            }
        );

    timelog
        .command("list")
        .description("List time logs (per work item or cross-WI query)")
        .option("-w, --workitem <id>", "Work item ID (optional with date filters)")
        .option("--since <date>", "Start date (YYYY-MM-DD)")
        .option("--upto <date>", "End date (YYYY-MM-DD)")
        .option("--day <date>", "Single day (YYYY-MM-DD)")
        .option("--user <name>", "Filter by user name (can repeat)", collectUsers, [])
        .option("--format <format>", "Output format: ai|md|json|table", "ai")
        .action(
            async (options: {
                workitem?: string;
                since?: string;
                upto?: string;
                day?: string;
                user?: string[];
                format?: string;
            }) => {
                const config = requireTimeLogConfig();
                const user = requireTimeLogUser(config);
                const api = new TimeLogApi(config.orgId!, config.projectId, config.timelog!.functionsKey, user);

                let entries: Array<{
                    timeLogId: string;
                    comment: string | null;
                    timeTypeDescription: string;
                    minutes: number;
                    date: string;
                    userName: string;
                    userEmail?: string | null;
                    workItemId?: number;
                    week?: string;
                }>;

                const hasDateFilter = !!(options.since || options.upto || options.day);
                const hasWorkItem = !!options.workitem;

                if (hasWorkItem && !hasDateFilter) {
                    // Backward compat: single work item query
                    const workItemId = parseInt(options.workitem!, 10);
                    if (isNaN(workItemId)) {
                        console.error("❌ Invalid work item ID");
                        process.exit(1);
                    }
                    const raw = await api.getWorkItemTimeLogs(workItemId);
                    entries = raw.map((e) => ({ ...e, comment: e.comment || null, workItemId }));
                } else if (hasDateFilter || !hasWorkItem) {
                    // Cross-WI query
                    if (!hasDateFilter && !hasWorkItem) {
                        console.error("❌ Provide --workitem, --day, --since/--upto, or a combination");
                        process.exit(1);
                    }
                    const fromDate = options.day || options.since;
                    const toDate = options.day || options.upto;
                    if (!fromDate) {
                        console.error("❌ --since or --day is required for date queries");
                        process.exit(1);
                    }

                    const raw = await api.queryTimeLogs({
                        FromDate: fromDate,
                        ToDate: toDate || fromDate,
                        projectId: config.projectId,
                        workitemId: hasWorkItem ? parseInt(options.workitem!, 10) : undefined,
                    });
                    entries = raw;
                } else {
                    entries = [];
                }

                // Post-filter by user name
                if (options.user && options.user.length > 0) {
                    const userFilters = options.user.map((u) => u.toLowerCase());
                    entries = entries.filter((e) =>
                        userFilters.some((uf) => e.userName.toLowerCase().includes(uf))
                    );
                }

                // Normalize date format (query returns "2026-01-30T00:00:00", per-WI returns "2026-01-30")
                for (const e of entries) {
                    if (e.date.includes("T")) {
                        e.date = e.date.split("T")[0];
                    }
                }

                // JSON output
                if (options.format === "json") {
                    console.log(JSON.stringify(entries, null, 2));
                    return;
                }

                if (entries.length === 0) {
                    console.log("No time logs found.");
                    return;
                }

                // Sort by date descending
                entries.sort((a, b) => b.date.localeCompare(a.date));

                // Calculate totals
                const totalMinutes = entries.reduce((sum, e) => sum + e.minutes, 0);
                const byType: Record<string, number> = {};
                for (const entry of entries) {
                    byType[entry.timeTypeDescription] = (byType[entry.timeTypeDescription] || 0) + entry.minutes;
                }

                if (options.format === "table") {
                    // Table output using cli-table3
                    const table = new Table({
                        head: ["ID", "Date", "WI", "Type", "Time", "User", "Comment"],
                        colWidths: [10, 12, 8, 16, 8, 22, 26],
                        wordWrap: true,
                        style: { head: ["cyan"] },
                    });

                    for (const e of entries) {
                        table.push([
                            e.timeLogId.substring(0, 8),
                            e.date,
                            e.workItemId ? `#${e.workItemId}` : "-",
                            e.timeTypeDescription,
                            formatMinutes(e.minutes),
                            e.userName,
                            (e.comment || "-").substring(0, 24),
                        ]);
                    }

                    console.log(table.toString());
                    console.log(`\n${pc.bold(`Total: ${formatMinutes(totalMinutes)}`)} (${entries.length} entries)`);
                    console.log("\nBy Type:");
                    for (const [type, mins] of Object.entries(byType)) {
                        console.log(`  ${type}: ${formatMinutes(mins)}`);
                    }
                    return;
                }

                if (options.format === "md") {
                    const title = hasWorkItem && !hasDateFilter
                        ? `## Time Logs for #${options.workitem}\n`
                        : `## Time Logs\n`;
                    console.log(title);
                    console.log(`| ID | Date | WI | Type | Time | User | Comment |`);
                    console.log(`|----|------|-----|------|------|------|---------|`);
                    for (const e of entries) {
                        const wi = e.workItemId ? `#${e.workItemId}` : "-";
                        console.log(
                            `| ${e.timeLogId.substring(0, 8)} | ${e.date} | ${wi} | ${e.timeTypeDescription} | ${formatMinutes(e.minutes)} | ${e.userName} | ${e.comment || "-"} |`
                        );
                    }
                    console.log(`\n**Total: ${formatMinutes(totalMinutes)}**`);
                } else {
                    // AI format
                    const title = hasWorkItem && !hasDateFilter
                        ? `Time Logs for Work Item #${options.workitem}`
                        : "Time Logs";
                    console.log(title);
                    console.log("=".repeat(40));
                    for (const e of entries) {
                        const wi = e.workItemId ? ` [#${e.workItemId}]` : "";
                        console.log(`\n${e.date} - ${formatMinutes(e.minutes)} (${e.timeTypeDescription})${wi}`);
                        console.log(`  ID: ${e.timeLogId}`);
                        console.log(`  User: ${e.userName}`);
                        if (e.comment) console.log(`  Comment: ${e.comment}`);
                    }
                    console.log(`\n${"=".repeat(40)}`);
                    console.log(`Total: ${formatMinutes(totalMinutes)}`);
                    console.log("\nBy Type:");
                    for (const [type, mins] of Object.entries(byType)) {
                        console.log(`  ${type}: ${formatMinutes(mins)}`);
                    }
                }
            }
        );

    timelog
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

    timelog
        .command("import")
        .description("Import time logs from JSON file")
        .argument("<file>", "JSON file path")
        .option("--dry-run", "Validate without creating entries")
        .action(async (file: string, options: { dryRun?: boolean }) => {
            const config = requireTimeLogConfig();
            const user = requireTimeLogUser(config);

            if (!existsSync(file)) {
                console.error(`❌ File not found: ${file}`);
                process.exit(1);
            }

            let data: TimeLogImportFile;
            try {
                const content = readFileSync(file, "utf-8");
                data = JSON.parse(content);
            } catch (e) {
                console.error(`❌ Invalid JSON: ${(e as Error).message}`);
                process.exit(1);
            }

            if (!data.entries || !Array.isArray(data.entries)) {
                console.error(`❌ Invalid format: expected { entries: [...] }`);
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
                console.error("❌ Validation errors:");
                for (const err of errors) {
                    console.error(`  - ${err}`);
                }
                if (validEntries.length === 0) {
                    process.exit(1);
                }
                console.log(`\n${validEntries.length} entries are valid.\n`);
            }

            if (options.dryRun) {
                console.log("✔ Dry run complete. Valid entries:");
                for (const e of validEntries) {
                    console.log(`  #${e.workItemId}: ${formatMinutes(e.minutes)} ${e.timeType} on ${e.date}`);
                }
                return;
            }

            // Create entries
            console.log(`Creating ${validEntries.length} time log entries...`);
            let created = 0;
            const failed: string[] = [];

            for (const entry of validEntries) {
                try {
                    const ids = await api.createTimeLogEntry(
                        entry.workItemId,
                        entry.minutes,
                        entry.timeType,
                        entry.date,
                        entry.comment
                    );
                    created++;
                    const parts = [
                        `#${entry.workItemId}`,
                        formatMinutes(entry.minutes),
                        entry.timeType,
                        entry.date,
                    ];
                    if (entry.comment) parts.push(entry.comment);
                    parts.push(`[${ids[0].substring(0, 8)}]`);
                    console.log(`  ✔ ${parts.join(" | ")}`);
                } catch (e) {
                    failed.push(`#${entry.workItemId}: ${(e as Error).message}`);
                }
            }

            console.log(`\n✔ Created ${created}/${validEntries.length} entries`);
            if (failed.length > 0) {
                console.error("\nFailed:");
                for (const f of failed) {
                    console.error(`  - ${f}`);
                }
            }
        });

    timelog
        .command("delete")
        .description("Delete a time log entry")
        .argument("[timeLogId]", "Time log entry ID (or use --workitem for interactive)")
        .option("-w, --workitem <id>", "Work item ID (interactive picker)")
        .action(
            async (timeLogIdArg: string | undefined, options: { workitem?: string }) => {
                const config = requireTimeLogConfig();
                const user = requireTimeLogUser(config);
                const api = new TimeLogApi(config.orgId!, config.projectId, config.timelog!.functionsKey, user);

                let timeLogId = timeLogIdArg;

                if (!timeLogId) {
                    // Interactive mode: pick from work item's entries
                    if (!options.workitem) {
                        console.error("❌ Provide a timeLogId or --workitem for interactive selection");
                        console.error("\nExamples:");
                        console.error("  tools azure-devops timelog delete <timeLogId>");
                        console.error("  tools azure-devops timelog delete --workitem 268935");
                        process.exit(1);
                    }

                    const workItemId = parseInt(options.workitem, 10);
                    if (isNaN(workItemId)) {
                        console.error("❌ Invalid work item ID");
                        process.exit(1);
                    }

                    const entries = await api.getWorkItemTimeLogs(workItemId);
                    if (entries.length === 0) {
                        console.log(`No time logs found for #${workItemId}`);
                        return;
                    }

                    const selected = await p.select({
                        message: `Select entry to delete from #${workItemId}:`,
                        options: entries.map((e) => ({
                            value: e.timeLogId,
                            label: `${e.date} | ${formatMinutes(e.minutes)} | ${e.timeTypeDescription} | ${e.userName}${e.comment ? ` | ${e.comment}` : ""}`,
                        })),
                    });

                    if (p.isCancel(selected)) {
                        p.cancel("Cancelled");
                        return;
                    }

                    timeLogId = selected as string;
                }

                // Confirm deletion
                const confirm = await p.confirm({
                    message: `Delete time log entry ${timeLogId.substring(0, 8)}...?`,
                });

                if (p.isCancel(confirm) || !confirm) {
                    p.cancel("Cancelled");
                    return;
                }

                await api.deleteTimeLogEntry(timeLogId);
                console.log(`✔ Deleted time log entry ${timeLogId.substring(0, 8)}...`);
            }
        );

    timelog
        .command("configure")
        .description("Auto-fetch TimeLog API settings from Azure DevOps")
        .action(async () => {
            const config = loadConfig() as AzureConfigWithTimeLog | null;
            if (!config?.org) {
                console.error("❌ Run 'tools azure-devops configure <url>' first");
                process.exit(1);
            }

            // Extract org name from URL (e.g., "MyOrg" from "https://dev.azure.com/MyOrg")
            const orgMatch = config.org.match(/dev\.azure\.com\/([^/]+)/);
            const orgName = orgMatch?.[1];
            if (!orgName) {
                console.error("❌ Could not extract organization name from config.org");
                process.exit(1);
            }

            console.log("Fetching TimeLog extension settings...");

            try {
                const result =
                    await $`az rest --method GET --resource "499b84ac-1321-427f-aa17-267ca6975798" --uri "https://extmgmt.dev.azure.com/${orgName}/_apis/ExtensionManagement/InstalledExtensions/TimeLog/time-logging/Data/Scopes/Default/Current/Collections/%24settings/Documents?api-version=7.1-preview"`.quiet();

                const data = JSON.parse(result.text());
                const configDoc = data.find((d: { id: string }) => d.id === "Config");

                if (!configDoc?.value) {
                    console.error("❌ TimeLog extension not configured in Azure DevOps");
                    process.exit(1);
                }

                const settings = JSON.parse(configDoc.value);
                const apiKey = settings.find((s: { id: string }) => s.id === "ApiKeyTextBox")?.value;

                if (!apiKey) {
                    console.error("❌ API key not found in TimeLog settings");
                    process.exit(1);
                }

                // Update config with TimeLog settings
                const configPath = findConfigPath();
                if (!configPath) {
                    console.error("❌ Config file not found");
                    process.exit(1);
                }

                const existingConfig = JSON.parse(readFileSync(configPath, "utf-8"));
                existingConfig.timelog = existingConfig.timelog || {};
                existingConfig.timelog.functionsKey = apiKey;

                writeFileSync(configPath, JSON.stringify(existingConfig, null, 2));
                console.log("✔ TimeLog API key saved to config");
                console.log("\nNext: Add your user info to config.json:");
                console.log('  "timelog": {');
                console.log('    "functionsKey": "...",');
                console.log('    "defaultUser": {');
                console.log('      "userId": "<your-azure-ad-object-id>",');
                console.log('      "userName": "<Your Name>",');
                console.log('      "userEmail": "<your-email>"');
                console.log("    }");
                console.log("  }");
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                console.error("❌ Failed to fetch TimeLog settings:", message);
                process.exit(1);
            }
        });
}

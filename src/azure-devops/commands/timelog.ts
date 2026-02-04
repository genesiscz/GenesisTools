import { Command } from "commander";
import { $ } from "bun";
import { readFileSync, writeFileSync } from "fs";
import { loadConfig, findConfigPath, requireTimeLogConfig, requireTimeLogUser } from "@app/azure-devops/utils";
import { TimeLogApi, formatMinutes, convertToMinutes, getTodayDate } from "@app/azure-devops/timelog-api";
import { loadTimeTypesCache, saveTimeTypesCache } from "@app/azure-devops/cache";
import { runInteractiveAddClack } from "@app/azure-devops/timelog-prompts-clack";
import { runInteractiveAddInquirer } from "@app/azure-devops/timelog-prompts-inquirer";
import logger from "@app/logger";
import type { AzureConfigWithTimeLog, TimeType, TimeLogUser } from "@app/azure-devops/types";

// Toggle between prompt implementations
// 1 = @clack/prompts (preferred)
// 0 = @inquirer/prompts (fallback)
const USE_CLACK = 1;

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
  list     List time logs for a work item
  types    List available time types
  import   Import time logs from JSON file

Examples:
  tools azure-devops timelog add --workitem 268935 --hours 2 --type "Development"
  tools azure-devops timelog add --workitem 268935 --hours 1 --minutes 30 --type "Code Review" --comment "PR review"
  tools azure-devops timelog add --workitem 268935 --interactive
  tools azure-devops timelog list --workitem 268935
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
    .action(async (options: {
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

      const api = new TimeLogApi(
        config.orgId!,
        config.projectId,
        config.timelog!.functionsKey,
        user
      );

      // Validate time type exists
      const validType = await api.validateTimeType(options.type);
      if (!validType) {
        const types = await api.getTimeTypes();
        console.error(`
❌ Unknown time type: "${options.type}"

Available types:
${types.map(t => `  - ${t.description}`).join("\n")}
`);
        process.exit(1);
      }

      const date = options.date || getTodayDate();
      const comment = options.comment || "";

      // Create the entry
      const ids = await api.createTimeLogEntry(
        workItemId,
        totalMinutes,
        validType.description,  // Use exact casing from API
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
    });

  timelog
    .command("list")
    .description("List time logs for a work item")
    .requiredOption("-w, --workitem <id>", "Work item ID")
    .option("--format <format>", "Output format: ai|md|json", "ai")
    .action(async (options: { workitem: string; format?: string }) => {
      const config = requireTimeLogConfig();
      const user = requireTimeLogUser(config);
      const workItemId = parseInt(options.workitem, 10);

      if (isNaN(workItemId)) {
        console.error("❌ Invalid work item ID");
        process.exit(1);
      }

      const api = new TimeLogApi(
        config.orgId!,
        config.projectId,
        config.timelog!.functionsKey,
        user
      );

      const entries = await api.getWorkItemTimeLogs(workItemId);

      if (options.format === "json") {
        console.log(JSON.stringify(entries, null, 2));
        return;
      }

      if (entries.length === 0) {
        console.log(`No time logs found for work item #${workItemId}`);
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

      if (options.format === "md") {
        console.log(`## Time Logs for #${workItemId}\n`);
        console.log(`| Date | Type | Time | User | Comment |`);
        console.log(`|------|------|------|------|---------|`);
        for (const e of entries) {
          console.log(`| ${e.date} | ${e.timeTypeDescription} | ${formatMinutes(e.minutes)} | ${e.userName} | ${e.comment || "-"} |`);
        }
        console.log(`\n**Total: ${formatMinutes(totalMinutes)}**`);
      } else {
        // AI format
        console.log(`Time Logs for Work Item #${workItemId}`);
        console.log("=".repeat(40));
        for (const e of entries) {
          console.log(`\n${e.date} - ${formatMinutes(e.minutes)} (${e.timeTypeDescription})`);
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
    });

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
        const api = new TimeLogApi(
          config.orgId!,
          config.projectId,
          config.timelog!.functionsKey,
          user
        );
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
    .action(async (file) => {
      console.log("TimeLog import - to be implemented");
      console.log("File:", file);
    });

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
        const result = await $`az rest --method GET --resource "499b84ac-1321-427f-aa17-267ca6975798" --uri "https://extmgmt.dev.azure.com/${orgName}/_apis/ExtensionManagement/InstalledExtensions/TimeLog/time-logging/Data/Scopes/Default/Current/Collections/%24settings/Documents?api-version=7.1-preview"`.quiet();

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
        console.log('    }');
        console.log('  }');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("❌ Failed to fetch TimeLog settings:", message);
        process.exit(1);
      }
    });
}

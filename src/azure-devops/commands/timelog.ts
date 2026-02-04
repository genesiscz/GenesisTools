import { Command } from "commander";
import { $ } from "bun";
import { readFileSync, writeFileSync } from "fs";
import { loadConfig, findConfigPath } from "@app/azure-devops/utils";
import type { AzureConfigWithTimeLog } from "@app/azure-devops/types";

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
    .action(async (options) => {
      // TODO: Implement after refactor is complete
      console.log("TimeLog add - to be implemented");
      console.log("Options:", options);
    });

  timelog
    .command("list")
    .description("List time logs for a work item")
    .requiredOption("-w, --workitem <id>", "Work item ID")
    .action(async (options) => {
      console.log("TimeLog list - to be implemented");
      console.log("Work item:", options.workitem);
    });

  timelog
    .command("types")
    .description("List available time types")
    .action(async () => {
      console.log("TimeLog types - to be implemented");
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

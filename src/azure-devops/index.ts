#!/usr/bin/env bun
/**
 * Azure DevOps Work Item CLI Tool
 *
 * Usage:
 *   tools azure-devops configure <any-azure-devops-url>
 *   tools azure-devops query <url|id> [options]
 *   tools azure-devops workitem <url|id> [options]
 *   tools azure-devops dashboard <url|id> [options]
 *   tools azure-devops list
 *   tools azure-devops workitem-create [options]
 *   tools azure-devops timelog <subcommand> [options]
 */

import { Command } from "commander";
import logger from "@app/logger";
import { handleReadmeFlag } from "@app/utils/readme";
import { exitWithAuthGuide, exitWithSslGuide, isAuthError, isSslError } from "@app/azure-devops/cli.utils";

// Handle --readme flag early (before Commander parses)
handleReadmeFlag(import.meta.url);

// Import command registration functions
import { registerConfigureCommand } from "@app/azure-devops/commands/configure";
import { registerQueryCommand, setWorkItemHandler } from "@app/azure-devops/commands/query";
import { registerWorkitemCommand, handleWorkItem } from "@app/azure-devops/commands/workitem";
import { registerWorkitemCreateCommand } from "@app/azure-devops/commands/workitem-create";
import { registerWorkitemCacheCommand } from "@app/azure-devops/commands/workitem-cache";
import { registerDashboardCommand } from "@app/azure-devops/commands/dashboard";
import { registerTimelogCommand } from "@app/azure-devops/commands/timelog";

// Wire up cross-command dependencies
// Query command needs to call workitem handler for --download-workitems
setWorkItemHandler(handleWorkItem);

const program = new Command();

program
  .name("azure-devops")
  .description("Azure DevOps Work Item CLI Tool")
  .version("1.0.0")
  .option("-v, --verbose", "Enable verbose debug logging")
  .option("-?, --help-full", "Show detailed help with examples")
  .on("option:help-full", () => {
    showHelpFull();
    process.exit(0);
  });

// Register all commands
registerConfigureCommand(program);
registerQueryCommand(program);
registerWorkitemCommand(program);
registerWorkitemCreateCommand(program);
registerWorkitemCacheCommand(program);
registerDashboardCommand(program);
registerTimelogCommand(program);

function showHelpFull(): void {
  console.log(`
Azure DevOps Work Item Tool

Usage:
  tools azure-devops <command> [options]

Commands:
  configure <url>        Configure organization and project from any Azure DevOps URL
  query <input>          Run an Azure DevOps query and display results
  workitem <input>       Fetch work item(s) by ID or URL
  dashboard <input>      Fetch dashboard and list its queries
  list                   List cached work items
  workitem-create        Create a new work item (interactive or from template)
  timelog                Manage time log entries (add, list, types, import)

Query Options:
  --format <ai|md|json>  Output format (default: ai)
  --force                Force refresh, ignore cache
  --state <states>       Filter by state (comma-separated)
  --severity <sev>       Filter by severity (comma-separated)
  --changes-from <date>  Show changes from this date (ISO format)
  --changes-to <date>    Show changes up to this date (ISO format)
  --download-workitems   Download all work items to tasks/
  --category <name>      Save to tasks/<category>/ (remembered per work item)
  --task-folders         Save in tasks/<id>/ subfolder

Workitem Options:
  --format <ai|md|json>  Output format (default: ai)
  --force                Force refresh, ignore cache
  --category <name>      Save to tasks/<category>/
  --task-folders         Save in tasks/<id>/ subfolder

Workitem-Create Options:
  -i, --interactive      Interactive mode with prompts
  --from-file <path>     Create from template file
  --type <type>          Work item type (Bug, Task, User Story, etc.)
  --title <text>         Work item title (for quick creation)
  --severity <sev>       Severity level
  --tags <tags>          Tags (comma-separated)
  --assignee <email>     Assignee email

Timelog Subcommands:
  timelog add            Add a time log entry
  timelog list           List time logs for a work item
  timelog types          List available time types
  timelog import <file>  Import time logs from JSON file

First-Time Setup:
  1. Install Azure CLI: https://learn.microsoft.com/en-us/cli/azure/install-azure-cli
  2. Install extension: az extension add --name azure-devops
  3. Login: az login --allow-no-subscriptions --use-device-code
  4. Configure: tools azure-devops configure "https://dev.azure.com/MyOrg/MyProject/_workitems"

Examples:
  # Configure with any Azure DevOps URL
  tools azure-devops configure "https://dev.azure.com/MyOrg/MyProject/_workitems"
  tools azure-devops configure "https://myorg.visualstudio.com/MyProject/_queries/query/..."

  # Fetch query
  tools azure-devops query d6e14134-9d22-4cbb-b897-b1514f888667

  # Fetch work items (supports comma-separated IDs)
  tools azure-devops workitem 12345
  tools azure-devops workitem 12345,12346,12347

  # Force refresh
  tools azure-devops workitem 12345 --force

  # Filter by state/severity
  tools azure-devops query abc123 --state Active,Development
  tools azure-devops query abc123 --severity A,B

  # Download all work items from a query to tasks/
  tools azure-devops query abc123 --download-workitems
  tools azure-devops query abc123 --state Active --download-workitems --force

  # Organize work items into categories
  tools azure-devops query abc123 --download-workitems --category react19
  tools azure-devops workitem 12345 --category hotfixes

  # Interactive work item creation
  tools azure-devops workitem-create -i

  # Generate template from query
  tools azure-devops workitem-create "https://dev.azure.com/.../query/abc" --type Bug

  # Quick non-interactive creation
  tools azure-devops workitem-create --type Task --title "Fix login bug"

  # Time logging
  tools azure-devops timelog add --workitem 268935 --hours 2 --type "Development"
  tools azure-devops timelog list --workitem 268935
  tools azure-devops timelog types

Storage:
  Config:  .claude/azure/config.json (per-project, searched up to 3 levels)
  Cache:   ~/.genesis-tools/azure-devops/cache/ (global, 180 days)
  Tasks:   .claude/azure/tasks/ (per-project, in cwd)

Documentation: https://learn.microsoft.com/en-us/azure/devops/cli/?view=azure-devops
`);
}

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (isSslError(message)) {
      exitWithSslGuide(error);
    }

    if (isAuthError(message)) {
      exitWithAuthGuide(error);
    }

    logger.error(`Error: ${message}`);

    if (error instanceof Error && error.stack) {
      logger.debug(error.stack);
    }

    process.exit(1);
  }
}

main().catch((err) => {
  logger.error(`Unexpected error: ${err}`);
  process.exit(1);
});

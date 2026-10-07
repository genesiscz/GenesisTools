#!/usr/bin/env bun

/**
 * Azure DevOps Work Item CLI Tool
 *
 * Usage:
 *   tools azure-devops configure <any-azure-devops-url>
 *   tools azure-devops query <url|id> [options]
 *   tools azure-devops workitem <url|id> [options]
 *   tools azure-devops ancestors <id> [options]
 *   tools azure-devops tree <id> [options]
 *   tools azure-devops dashboard <url|id> [options]
 *   tools azure-devops list
 *   tools azure-devops workitem-create [options]
 *   tools azure-devops timelog <add|list|delete|types|import|configure|prepare-import|export-month> [options]
 *   tools azure-devops history <show|search|sync|activity|mentions> [options]
 *   tools azure-devops iterations [options]
 *   tools azure-devops sprint [nameOrPath] [options]
 *   tools azure-devops wiki <list|pages|get|search|history|diff> [options]
 *   tools azure-devops comment <list|add|edit|delete> <workitem> [options]
 */

import { exitWithAuthGuide, exitWithSslGuide, isAuthError, isSslError } from "@app/azure-devops/cli.utils";
import { azLoginSuggestionBlock } from "@app/azure-devops/lib/az-cli.utils";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { logger, out } from "@genesiscz/utils/logger";
import * as p from "@genesiscz/utils/prompts/p";
import { inquirerBackend } from "@genesiscz/utils/prompts/p/inquirer-backend";
import { handleReadmeFlag } from "@genesiscz/utils/readme";

// Use inquirer backend for this tool
p.setBackend(inquirerBackend);

import { Command } from "commander";

// Handle --readme flag early (before Commander parses)
handleReadmeFlag(import.meta.url);

// Import command registration functions
import { registerAncestorsCommand } from "@app/azure-devops/commands/ancestors";
import { registerCommentCommand } from "@app/azure-devops/commands/comment";
import { registerConfigureCommand } from "@app/azure-devops/commands/configure";
import { registerDashboardCommand } from "@app/azure-devops/commands/dashboard";
import { registerHistoryCommand } from "@app/azure-devops/commands/history";
import { registerQueryCommand, setWorkItemHandler } from "@app/azure-devops/commands/query";
import { registerSprintCommands } from "@app/azure-devops/commands/sprint";
import { registerTimelogCommand } from "@app/azure-devops/commands/timelog";
import { registerTreeCommand } from "@app/azure-devops/commands/tree";
import { registerWikiCommand } from "@app/azure-devops/commands/wiki";
import { handleWorkItem, registerWorkitemCommand } from "@app/azure-devops/commands/workitem";
import { registerWorkitemCacheCommand } from "@app/azure-devops/commands/workitem-cache";
import { registerWorkitemCreateCommand } from "@app/azure-devops/commands/workitem-create";
import { runTool } from "@genesiscz/utils/cli";

// Wire up cross-command dependencies
// Query command needs to call workitem handler for --download-workitems
setWorkItemHandler(handleWorkItem);

const program = new Command();

program
    .name("azure-devops")
    .description("Azure DevOps Work Item CLI Tool")
    .version("1.0.0")
    .showHelpAfterError(true)
    .option("-v, --verbose", "Enable verbose debug logging")
    .option("--team <name>", "Optional Azure DevOps team name; narrows team-scoped lists (overrides config.team)")
    .option("-?, --help-full", "Show detailed help with examples")
    .on("option:help-full", () => {
        showHelpFull();
        process.exit(0);
    });

// Register all commands
registerConfigureCommand(program);
registerQueryCommand(program);
registerWorkitemCommand(program);
registerAncestorsCommand(program);
registerTreeCommand(program);
registerWorkitemCreateCommand(program);
registerWorkitemCacheCommand(program);
registerDashboardCommand(program);
registerTimelogCommand(program);
registerHistoryCommand(program);
registerSprintCommands(program);
registerWikiCommand(program);
registerCommentCommand(program);

function showHelpFull(): void {
    out.println(`
Azure DevOps Work Item Tool

Usage:
  ${toolCommand("azure-devops")} <command> [options]

Commands:
  configure <url>        Configure organization and project from any Azure DevOps URL (alias: config)
  query <input>          Run an Azure DevOps query and display results
  workitem <input>       Fetch work item(s) by ID or URL (alias: wi)
  ancestors <id>         Walk a work item's parent chain up to the root
  tree <id>              Parents, children and related items of one work item
  dashboard <input>      Fetch dashboard and list its queries
  list                   List cached work items (alias: ls)
  workitem-create        Create a new work item, interactive or from template (alias: create)
  timelog                Manage time log entries (add, list, delete, types, import, configure,
                         prepare-import, export-month)
  history                Work item history commands (show, search, sync, activity, mentions)
  iterations             List the project's sprints (alias: sprints)
  sprint [nameOrPath]    List the work items of one sprint
  wiki <subcommand>      Wikis: list, pages, get, search, history, diff
  comment <subcommand>   Work item comments: list, add, edit, delete

Global Options:
  --team <name>          Optional team; narrows team-scoped lists (overrides config.team)
  -v, --verbose          Enable verbose debug logging
  --readme               Print this tool's README and exit

Sprint Options:
  -f, --format <fmt>     ai | md | json (default: ai)
  --mine                 Only work items assigned to me (@Me)
  --assigned-to <name>   Only work items assigned to this person
  --totals               Task-only CompletedWork / RemainingWork sums
  --order                Sort by Backlog stack rank and show the Order column

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
  --tree                 Print the saved query as a tree with its own columns

Workitem Options:
  --format <ai|md|json>  Output format (default: ai)
  --force                Force refresh, ignore cache
  --full                 Full description and comments, no truncation
  --category <name>      Save to tasks/<category>/
  --task-folders         Save in tasks/<id>/ subfolder
  --images               Download inline images from description and comments
  --attachments-from <datetime>, --attachments-to <datetime>
  --attachments-prefix <prefix>, --attachments-suffix <suffix>
  --output-dir <path>    Custom directory for downloaded attachments

Ancestors / Tree Options:
  --format <table|json>  Output format (default: table)
  --depth <n>            ancestors: cap the climb at n ancestors (default: to the root)
  --force                tree: refetch every work item instead of reading the cache

Workitem-Create Options:
  -i, --interactive      Interactive mode with prompts
  --from-file <path>     Create from template file
  --type <type>          Work item type (Bug, Task, User Story, etc.)
  --title <text>         Work item title (for quick creation)
  --severity <sev>       Severity level
  --tags <tags>          Tags (comma-separated)
  --assignee <email>     Assignee email
  --parent <id>          Parent work item ID

Timelog Subcommands:
  timelog add            Add a time log entry (--date <date>, default today)
  timelog list           List time logs (--workitem, --day, --from/--to, --user)
  timelog delete         Delete a time log entry and roll back effort
  timelog types          List available time types
  timelog import <file>  Import time logs from JSON file
  timelog configure      Set the allowed work item types, states and deprioritized states
  timelog prepare-import Build an import file entry by entry, with validation (add, list, remove, clear)
  timelog export-month   Export one month of time logs with a summary (--month, --year)

First-Time Setup:
  1. Install Azure CLI: https://learn.microsoft.com/en-us/cli/azure/install-azure-cli
  2. Install extension: az extension add --name azure-devops
  3. Login:
${azLoginSuggestionBlock({ indent: "     " })}
  4. Configure: ${toolCommand("azure-devops configure")} "https://dev.azure.com/MyOrg/MyProject/_workitems"

Examples:
  # Configure with any Azure DevOps URL
  ${toolCommand("azure-devops configure")} "https://dev.azure.com/MyOrg/MyProject/_workitems"
  ${toolCommand("azure-devops configure")} "https://myorg.visualstudio.com/MyProject/_queries/query/..."

  # Fetch query
  ${toolCommand("azure-devops query")} d6e14134-9d22-4cbb-b897-b1514f888667

  # Saved tree, with the columns the query editor shows
  ${toolCommand("azure-devops query")} <id-or-url> --tree
  ${toolCommand("azure-devops query")} <id-or-url> --tree -f json

  # Fetch work items (supports comma-separated IDs)
  ${toolCommand("azure-devops workitem")} 12345
  ${toolCommand("azure-devops workitem")} 12345,12346,12347

  # Force refresh
  ${toolCommand("azure-devops workitem")} 12345 --force

  # Filter by state/severity
  ${toolCommand("azure-devops query")} abc123 --state Active,Development
  ${toolCommand("azure-devops query")} abc123 --severity A,B

  # Download all work items from a query to tasks/
  ${toolCommand("azure-devops query")} abc123 --download-workitems
  ${toolCommand("azure-devops query")} abc123 --state Active --download-workitems --force

  # Organize work items into categories
  ${toolCommand("azure-devops query")} abc123 --download-workitems --category react19
  ${toolCommand("azure-devops workitem")} 12345 --category hotfixes

  # Interactive work item creation
  ${toolCommand("azure-devops workitem-create")} -i

  # Generate template from query
  ${toolCommand("azure-devops workitem-create")} "https://dev.azure.com/.../query/abc" --type Bug

  # Quick non-interactive creation
  ${toolCommand("azure-devops workitem-create")} --type Task --title "Fix login bug"

  # Time logging
  ${toolCommand("azure-devops timelog add")} --workitem 12345 --hours 2 --type "Development"
  ${toolCommand("azure-devops timelog list")} --workitem 12345
  ${toolCommand("azure-devops timelog delete")} <timeLogId> --yes
  ${toolCommand("azure-devops timelog types")}
  ${toolCommand("azure-devops timelog export-month")} --month 2 --year 2026

Ancestors and Tree:
  ${toolCommand("azure-devops ancestors")} 12345 --depth 2
  ${toolCommand("azure-devops tree")} 12345 --format json

Sprint Commands:
  ${toolCommand("azure-devops iterations")}                          List the project's sprints
  ${toolCommand("azure-devops sprint")} --mine --totals               Current sprint, my items, effort sums
  ${toolCommand("azure-devops sprint")} "Sprint 17" --order   One sprint in Backlog order
  # These never use @CurrentIteration: that macro needs a team context and
  # fails with VS402612. An explicit [System.IterationPath] predicate is used.

Wiki Commands:
  ${toolCommand("azure-devops wiki list")}                     The project's wikis
  ${toolCommand("azure-devops wiki pages")} [path] --depth 2   Page tree under a path
  ${toolCommand("azure-devops wiki get")} <url|id|path>        Page details + markdown (--images, -o, -f json)
  ${toolCommand("azure-devops wiki search")} "<text>"          Full-text search over the pages
  ${toolCommand("azure-devops wiki history")} <page>           Commits that changed the page
  ${toolCommand("azure-devops wiki diff")} <page> [from] [to]  What an edit changed (default: the last one)

Comment Commands:
  ${toolCommand("azure-devops comment list")} <id>                     Comments, newest first (--format json)
  ${toolCommand("azure-devops comment add")} <id> --file note.md       Post markdown (--text "...", --file - for stdin, --html)
  ${toolCommand("azure-devops comment edit")} <id> <commentId> --file note.md   Replace a comment's text
  ${toolCommand("azure-devops comment delete")} <id> <commentId> --yes Delete a comment (--yes is required without a terminal)

History Commands:
  ${toolCommand("azure-devops history show")} <id>          Show history for a work item
  ${toolCommand("azure-devops history search")} --wiql      Search via WIQL EVER query (server-side)
  ${toolCommand("azure-devops history search")}             Search local cached history
  ${toolCommand("azure-devops history sync")}               Bulk sync history for cached items (--since <date>, --batch)
  ${toolCommand("azure-devops history activity")}           A user's activity timeline (--user, --from, --to, --discover)
  ${toolCommand("azure-devops history mentions")}           Comments that named a user in a date window (--user, --from, --to)

Storage:
  Config:  .claude/azure/config.json (per-project, searched up to 3 levels)
  Cache:   ~/.genesis-tools/azure-devops/cache/ (global; queries 180 days, work items 365 days
           with a 5-minute freshness window, history and comments 7 days)
  Tasks:   .claude/azure/tasks/ (per-project, in cwd)

Documentation: https://learn.microsoft.com/en-us/azure/devops/cli/?view=azure-devops
`);
}

async function main(): Promise<void> {
    try {
        await runTool(program, { tool: "azure-devops" });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        if (isSslError(message)) {
            exitWithSslGuide(error);
        }

        if (isAuthError(message)) {
            exitWithAuthGuide(error);
        }

        logger.error(message);

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

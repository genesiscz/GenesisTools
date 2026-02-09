import type { Command } from "commander";
import { registerAddSubcommand } from "./timelog/add";
import { registerConfigureSubcommand } from "./timelog/configure";
import { registerDeleteSubcommand } from "./timelog/delete";
import { registerImportSubcommand } from "./timelog/import";
import { registerListSubcommand } from "./timelog/list";
import { registerPrepareImportSubcommand } from "./timelog/prepare-import";
import { registerTypesSubcommand } from "./timelog/types";

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
  Development, Code Review, Business Anal\u00fdza, IT Anal\u00fdza, Test,
  Dokumentace, Ceremonie, Konfigurace, Release, UX, ...

Hours/Minutes:
  --hours 2              \u2192 120 minutes
  --hours 1 --minutes 30 \u2192 90 minutes
  --minutes 30           \u2192 ERROR (use --hours 0 --minutes 30)
  --hours 0 --minutes 30 \u2192 30 minutes
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

    registerAddSubcommand(timelog);
    registerListSubcommand(timelog);
    registerTypesSubcommand(timelog);
    registerImportSubcommand(timelog);
    registerDeleteSubcommand(timelog);
    registerConfigureSubcommand(timelog);
    registerPrepareImportSubcommand(timelog);
}

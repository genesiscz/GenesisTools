import { Command } from "commander";

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
}

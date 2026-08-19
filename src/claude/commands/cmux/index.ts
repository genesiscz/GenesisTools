import { type Command, Option } from "commander";
import { pinsCommand } from "./pins";
import { restoreCommand } from "./restore";
import { forgetCommand, listCommand, snapshotCommand } from "./snapshot";

export function registerCmuxCommand(program: Command): void {
    const cmux = program
        .command("cmux")
        .description("Reopen recent Claude Code sessions as cmux workspaces (crash recovery, session sets)");

    cmux.command("restore [snapshot]", { isDefault: true })
        .description(
            "Pick sessions (or replay a snapshot) and rebuild them as cmux panes, each resuming " +
                "under the account it was pinned to"
        )
        .option("--last <n>", "How many recent sessions to offer, newest activity first", "12")
        .option("--this-project", "Only offer sessions from this directory's project (default: every project)")
        .addOption(
            new Option("--layout <mode>", "capped: grid + overflow workspaces | grid: one workspace | tabs: stack")
                .choices(["capped", "grid", "tabs"])
                .default("capped")
        )
        .option("--per-workspace <n>", "Max panes per workspace before overflowing (capped/tabs)", "4")
        .option("--no-per-project", "Put every session in one workspace set instead of one per project")
        .option("--no-enter", "Queue each pane's command at the prompt instead of running it")
        .option("--account <name>", "Force every pane onto this account, ignoring recorded pins")
        .option("-a, --autopick", "Panes with no recorded account auto-pick the best one instead of asking")
        .option("--new-window", "Build the workspaces in a new cmux window")
        .option("--dry-run", "Print the plan and stop")
        .option("-y, --yes", "Skip the picker and the confirmation")
        .action(restoreCommand);

    cmux.command("snapshot [name]")
        .description("Save the currently-active sessions as a named set you can restore after a crash")
        .option("--last <n>", "Max sessions to consider", "20")
        .option("--within <hours>", "Only sessions with transcript activity this recent", "12")
        .option("--this-project", "Only consider sessions from this directory's project")
        .option("-y, --yes", "Capture everything found without the picker")
        .action(snapshotCommand);

    cmux.command("list")
        .description("List saved snapshots")
        .option("--json", "Emit the snapshots as JSON instead of a table")
        .action(listCommand);

    cmux.command("forget <name>").description("Delete a saved snapshot").action(forgetCommand);

    cmux.command("pins")
        .description("Show the session → account pins the genesis-tools plugin hook has recorded")
        .option("--limit <n>", "How many recent pins to show", "15")
        .option("--json", "Emit the pins as JSON instead of a table")
        .action(pinsCommand);
}

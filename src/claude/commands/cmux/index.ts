import { type Command, Option } from "commander";
import { type HookAction, hookCommand } from "./hook-command";
import { recordCommand } from "./record";
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
        .option("--all-projects", "Offer sessions from every project, not just this directory's")
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
        .option("--all-projects", "Consider sessions from every project")
        .option("-y, --yes", "Capture everything found without the picker")
        .action(snapshotCommand);

    cmux.command("list").description("List saved snapshots").action(listCommand);

    cmux.command("forget <name>").description("Delete a saved snapshot").action(forgetCommand);

    cmux.command("hook [action]")
        .description("status | install | remove — the SessionStart hook that records each session's account")
        .action((action: string | undefined) => hookCommand((action as HookAction) ?? "status"));

    // The hook body itself: reads Claude Code's SessionStart payload on stdin.
    cmux.command("record", { hidden: true })
        .description("Internal: record this session's account pin from a SessionStart hook payload")
        .action(recordCommand);
}

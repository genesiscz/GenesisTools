import {
    PROJECT_OPTION_DESCRIPTION,
    reportMissingTodo,
    resolveProjectRoot,
    storeForProject,
} from "@app/todo/lib/project";
import { buildSyncReport, hasSyncableTime, type SyncTarget, syncTodo } from "@app/todo/lib/sync";
import { out } from "@genesiscz/utils/logger";
import { Command } from "commander";
import pc from "picocolors";

const SYNC_HELP = `
Every run prints one line per target on stdout:
  SYNC_OK calendar <todoId> created <eventId>          a new EventKit event exists
  SYNC_OK calendar <todoId> already-synced <eventId>   the event was created earlier
  SYNC_FAILED calendar <todoId>: <reason>              stderr, exit code 1

--all ends with exactly ONE of these two, so a parser always sees the run close:
  SYNC_SUMMARY <target> ok=<n> failed=<n> of <n>       last line when a todo was eligible
  SYNC_NOOP <target> <projectRoot>: <reason>           the only line when none was

Ids are per-project. Syncing an id created under another project root needs the same
--project <path> that created it; otherwise this command names the project that holds it.
Verify with: tools macos calendar search "<title>"
`;

export function createSyncCommand(): Command {
    return new Command("sync")
        .description("Create the Apple Calendar event or Reminders item for a todo")
        .argument("[id]", "Todo ID (required unless --all)")
        .requiredOption("--to <target>", "Sync target: calendar|reminders|both")
        .option("--all", "Sync all open todos with reminders")
        .option("--project <path>", PROJECT_OPTION_DESCRIPTION)
        .option("--calendar <name>", "Calendar to create the event in (default: GenesisTools)")
        .addHelpText("after", SYNC_HELP)
        .action(
            async (
                id: string | undefined,
                opts: { to: string; all?: boolean; project?: string; calendar?: string }
            ) => {
                const target = opts.to as SyncTarget;

                if (target !== "calendar" && target !== "reminders" && target !== "both") {
                    out.error(`Invalid sync target: ${opts.to}. Use "calendar", "reminders", or "both".`);
                    process.exit(1);
                }

                const projectRoot = resolveProjectRoot(opts.project);
                const store = storeForProject(opts.project);

                if (opts.all) {
                    const todos = await store.list({ status: ["todo", "in-progress", "blocked"] });
                    const syncable = todos.filter(hasSyncableTime);

                    if (syncable.length === 0) {
                        out.println(`SYNC_NOOP ${target} ${projectRoot}: no open todo has --at or a reminder.`);
                        return;
                    }

                    let succeeded = 0;
                    let failedTodos = 0;

                    for (const todo of syncable) {
                        const result = await syncTodo({ store, todo, target, calendarName: opts.calendar });
                        const report = buildSyncReport(result, todo.id);

                        for (const line of report.stdout) {
                            out.println(line);
                        }

                        for (const line of report.stderr) {
                            out.error(pc.red(line));
                        }

                        if (report.failed) {
                            failedTodos++;
                        } else {
                            succeeded++;
                        }
                    }

                    out.println(`SYNC_SUMMARY ${target} ok=${succeeded} failed=${failedTodos} of ${syncable.length}`);

                    if (failedTodos > 0) {
                        process.exitCode = 1;
                    }

                    return;
                }

                if (!id) {
                    out.error("Provide a todo ID or use --all.");
                    process.exit(1);
                }

                const todo = await store.get(id);

                if (!todo) {
                    const missing = await reportMissingTodo(id, projectRoot);

                    out.error(pc.red(missing.message));

                    process.exit(1);
                }

                if (!todo.at && todo.reminders.length === 0 && target !== "reminders") {
                    out.error(`SYNC_FAILED ${target} ${todo.id}: no event time — set one with \`--at\` first.`);
                    out.error(`  tools todo edit ${todo.id} --at "2026-09-15 12:00"`);
                    process.exit(1);
                }

                const result = await syncTodo({ store, todo, target, calendarName: opts.calendar });
                const report = buildSyncReport(result, todo.id);

                for (const line of report.stdout) {
                    out.println(line);
                }

                for (const line of report.stderr) {
                    out.error(pc.red(line));
                }

                if (report.failed) {
                    process.exitCode = 1;
                }
            }
        );
}

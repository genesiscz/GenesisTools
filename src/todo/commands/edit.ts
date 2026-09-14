import { resolveSessionOption } from "@app/todo/lib/context";
import { formatTodo } from "@app/todo/lib/format";
import { parseLink } from "@app/todo/lib/links";
import {
    PROJECT_OPTION_DESCRIPTION,
    reportMissingTodo,
    resolveProjectRoot,
    storeForProject,
} from "@app/todo/lib/project";
import { parseReminderTime } from "@app/todo/lib/reminders";
import { buildSyncReport, type SyncReport, type SyncTarget, syncTodo } from "@app/todo/lib/sync";
import type { OutputFormat, Todo, TodoPriority, TodoReminder } from "@app/todo/lib/types";
import { isInteractive, parseVariadic } from "@genesiscz/utils/cli";
import { out } from "@genesiscz/utils/logger";
import { Command, Option } from "commander";
import pc from "picocolors";

function resolveFormat(format: string | undefined): OutputFormat {
    if (format) {
        return format as OutputFormat;
    }

    return isInteractive() ? "md" : "ai";
}

function collect(value: string, previous: string[]): string[] {
    return [...previous, value];
}

export function createEditCommand(): Command {
    return new Command("edit")
        .description("Edit an existing todo")
        .argument("<id>", "Todo ID")
        .option("--title <text>", "New title")
        .option("--description <text>", "New description")
        .addOption(new Option("--priority <priority>", "New priority").choices(["critical", "high", "medium", "low"]))
        .option("--add-tag <tags>", "Add tags (comma-separated)")
        .option("--remove-tag <tags>", "Remove tags (comma-separated)")
        .option("--add-reminder <time>", "Add an alert on the event", collect, [])
        .option("--at <datetime>", "Set the event START time for calendar sync")
        .option("--add-link <link>", "Add a link", collect, [])
        .option("--session-id <id>", "Set session ID, or 'current' for this agent session")
        .option("--project <path>", PROJECT_OPTION_DESCRIPTION)
        .option("--calendar <name>", "Calendar to create the event in (default: GenesisTools)")
        .addOption(
            new Option("--sync-to <target>", "Create the Apple Calendar event / Reminders item now").choices([
                "calendar",
                "reminders",
                "both",
            ])
        )
        .addOption(new Option("-f, --format <format>", "Output format").choices(["ai", "json", "md", "table"]))
        .option("--colors", "Force colorized output even in non-TTY")
        .action(async (id, opts) => {
            const projectRoot = resolveProjectRoot(opts.project);
            const store = storeForProject(opts.project);
            const existing = await store.get(id);

            if (!existing) {
                const missing = await reportMissingTodo(id, projectRoot);

                out.error(pc.red(missing.message));

                process.exit(1);
            }

            const scalars: Partial<Todo> = {};

            if (opts.title) {
                scalars.title = opts.title;
            }

            if (opts.description) {
                scalars.description = opts.description;
            }

            if (opts.priority) {
                scalars.priority = opts.priority as TodoPriority;
            }

            if (opts.sessionId) {
                scalars.sessionId = resolveSessionOption(opts.sessionId);
            }

            if (opts.at) {
                scalars.at = parseReminderTime(opts.at);
            }

            // Parsing happens BEFORE the lock, so the critical section below stays a
            // pure computation on the row it is handed.
            const addedTags = opts.addTag ? parseVariadic(opts.addTag) : [];
            const removedTags = new Set(opts.removeTag ? parseVariadic(opts.removeTag) : []);
            const newReminders: TodoReminder[] = parseVariadic(opts.addReminder).map((r) => ({
                at: parseReminderTime(r),
                synced: null,
            }));
            const newLinks = parseVariadic(opts.addLink).map(parseLink);

            // Append to the row AS IT IS AT WRITE TIME. These arrays used to be built
            // from the `existing` snapshot read before the lock and written whole, so
            // an `--add-reminder` racing a `sync` dropped the identifier the sync had
            // just recorded — and the next sync then created a second event.
            let todo = await store.updateWith(id, (current) => {
                const patch: Partial<Todo> = { ...scalars };

                if (opts.addTag || opts.removeTag) {
                    let tags = [...current.tags];

                    if (opts.addTag) {
                        tags = [...new Set([...tags, ...addedTags])];
                    }

                    if (opts.removeTag) {
                        tags = tags.filter((t) => !removedTags.has(t));
                    }

                    patch.tags = tags;
                }

                if (newReminders.length > 0) {
                    patch.reminders = [...current.reminders, ...newReminders];
                }

                if (newLinks.length > 0) {
                    patch.links = [...current.links, ...newLinks];
                }

                return patch;
            });
            let report: SyncReport | undefined;

            if (opts.syncTo) {
                const target = opts.syncTo as SyncTarget;
                const result = await syncTodo({ store, todo, target, calendarName: opts.calendar });
                report = buildSyncReport(result, todo.id);
                todo = (await store.get(todo.id)) ?? todo;
            }

            const format = resolveFormat(opts.format);
            out.println(formatTodo(todo, format, { colors: opts.colors }));

            if (report) {
                // The record printed above already carries `syncId`, so repeating it
                // as a SYNC_OK line would leave `-f json` stdout unparseable — which
                // is exactly what this tool promises it stays.
                if (format !== "json") {
                    for (const line of report.stdout) {
                        out.println(line);
                    }
                }

                for (const line of report.stderr) {
                    out.error(pc.red(line));
                }

                if (report.failed) {
                    process.exitCode = 1;
                }
            }
        });
}

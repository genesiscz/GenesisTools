import { findProjectRoot } from "@app/todo/lib/context";
import { formatTodo } from "@app/todo/lib/format";
import { parseLink } from "@app/todo/lib/links";
import { parseReminderTime } from "@app/todo/lib/reminders";
import { TodoStore } from "@app/todo/lib/store";
import { type SyncTarget, syncTodo } from "@app/todo/lib/sync";
import type { OutputFormat, Todo, TodoPriority } from "@app/todo/lib/types";
import { isInteractive, parseVariadic } from "@app/utils/cli";
import { Command } from "commander";
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
        .option("--priority <priority>", "New priority: critical|high|medium|low")
        .option("--add-tag <tags>", "Add tags (comma-separated)")
        .option("--remove-tag <tags>", "Remove tags (comma-separated)")
        .option("--add-reminder <time>", "Add a reminder", collect, [])
        .option("--add-link <link>", "Add a link", collect, [])
        .option("--session-id <id>", "Set session ID")
        .option("--sync-to <target>", "Auto-sync reminders: calendar|reminders|both")
        .option("-f, --format <format>", "Output format")
        .action(async (id, opts) => {
            const projectRoot = findProjectRoot(process.cwd()) ?? process.cwd();
            const store = TodoStore.forProject(projectRoot);
            const existing = await store.get(id);

            if (!existing) {
                console.error(`Todo not found: ${id}`);
                process.exit(1);
            }

            const patch: Partial<Todo> = {};

            if (opts.title) {
                patch.title = opts.title;
            }

            if (opts.description) {
                patch.description = opts.description;
            }

            if (opts.priority) {
                patch.priority = opts.priority as TodoPriority;
            }

            if (opts.sessionId) {
                patch.sessionId = opts.sessionId;
            }

            if (opts.addTag || opts.removeTag) {
                let tags = [...existing.tags];

                if (opts.addTag) {
                    const newTags = parseVariadic(opts.addTag);
                    tags = [...new Set([...tags, ...newTags])];
                }

                if (opts.removeTag) {
                    const removeTags = new Set(parseVariadic(opts.removeTag));
                    tags = tags.filter((t) => !removeTags.has(t));
                }

                patch.tags = tags;
            }

            const addedReminders = parseVariadic(opts.addReminder);

            if (addedReminders.length > 0) {
                const newReminders = addedReminders.map((r) => ({
                    at: parseReminderTime(r),
                    synced: null as "calendar" | "reminders" | null,
                }));
                patch.reminders = [...existing.reminders, ...newReminders];
            }

            const addedLinks = parseVariadic(opts.addLink);

            if (addedLinks.length > 0) {
                const newLinks = addedLinks.map(parseLink);
                patch.links = [...existing.links, ...newLinks];
            }

            const todo = await store.update(id, patch);
            console.log(formatTodo(todo, resolveFormat(opts.format)));

            if (opts.syncTo && todo.reminders.length > 0) {
                const target = opts.syncTo as SyncTarget;
                const count = await syncTodo({ store, todo, target });

                if (count > 0) {
                    console.error(pc.green(`Synced ${count} reminder(s) to ${target}.`));
                }
            }
        });
}

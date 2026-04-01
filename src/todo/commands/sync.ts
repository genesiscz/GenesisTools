import { findProjectRoot } from "@app/todo/lib/context";
import { TodoStore } from "@app/todo/lib/store";
import type { Todo, TodoReminder } from "@app/todo/lib/types";
import { createCalendarEvent } from "@app/utils/macos/apple-calendar";
import { createReminder, todoPriorityToApple } from "@app/utils/macos/apple-reminders";
import chalk from "chalk";
import { Command } from "commander";

type SyncTarget = "calendar" | "reminders";

function syncReminderToCalendar(todo: Todo, reminder: TodoReminder): string {
    const startDate = new Date(reminder.at);
    const label = reminder.label ?? todo.title;

    return createCalendarEvent({
        title: label,
        notes: todo.description ?? `Todo: ${todo.id}`,
        startDate,
        alerts: [10],
    });
}

function syncTodoToReminders(todo: Todo): string {
    const firstReminder = todo.reminders.find((r) => !r.synced);
    const dueDate = firstReminder ? new Date(firstReminder.at) : undefined;

    return createReminder({
        title: todo.title,
        notes: todo.description ?? `Todo: ${todo.id}`,
        dueDate,
        priority: todoPriorityToApple(todo.priority),
    });
}

async function syncSingleTodo(options: {
    store: TodoStore;
    todo: Todo;
    target: SyncTarget;
}): Promise<number> {
    const { store, todo, target } = options;
    let syncCount = 0;

    if (target === "calendar") {
        const updatedReminders = [...todo.reminders];
        let changed = false;

        for (let i = 0; i < updatedReminders.length; i++) {
            const reminder = updatedReminders[i];

            if (reminder.synced === "calendar" && reminder.syncId) {
                continue;
            }

            const eventId = syncReminderToCalendar(todo, reminder);
            updatedReminders[i] = { ...reminder, synced: "calendar", syncId: eventId };
            changed = true;
            syncCount++;
        }

        if (changed) {
            await store.update(todo.id, { reminders: updatedReminders });
        }
    } else {
        const alreadySynced = todo.reminders.some((r) => r.synced === "reminders" && r.syncId);

        if (alreadySynced) {
            return 0;
        }

        const reminderId = syncTodoToReminders(todo);
        const updatedReminders = todo.reminders.map((r, i) => {
            if (i === 0) {
                return { ...r, synced: "reminders" as const, syncId: reminderId };
            }

            return r;
        });

        await store.update(todo.id, { reminders: updatedReminders });
        syncCount = 1;
    }

    return syncCount;
}

export function createSyncCommand(): Command {
    return new Command("sync")
        .description("Sync todos to Apple Calendar or Reminders")
        .argument("[id]", "Todo ID (required unless --all)")
        .requiredOption("--to <target>", "Sync target: calendar|reminders")
        .option("--all", "Sync all open todos with reminders")
        .action(async (id: string | undefined, opts: { to: string; all?: boolean }) => {
            const target = opts.to as SyncTarget;

            if (target !== "calendar" && target !== "reminders") {
                console.error(`Invalid sync target: ${opts.to}. Use "calendar" or "reminders".`);
                process.exit(1);
            }

            const projectRoot = findProjectRoot(process.cwd()) ?? process.cwd();
            const store = TodoStore.forProject(projectRoot);

            if (opts.all) {
                const todos = await store.list({ status: ["todo", "in-progress", "blocked"] });
                const withReminders = todos.filter((t) => t.reminders.length > 0);

                if (withReminders.length === 0) {
                    console.log("No open todos with reminders to sync.");
                    return;
                }

                let totalSynced = 0;

                for (const todo of withReminders) {
                    const count = await syncSingleTodo({ store, todo, target });

                    if (count > 0) {
                        console.log(chalk.green(`  ✓ ${todo.id}: ${todo.title} (${count} synced)`));
                        totalSynced += count;
                    }
                }

                console.log(`\nSynced ${totalSynced} item(s) to ${target}.`);
                return;
            }

            if (!id) {
                console.error("Provide a todo ID or use --all.");
                process.exit(1);
            }

            const todo = await store.get(id);

            if (!todo) {
                console.error(`Todo not found: ${id}`);
                process.exit(1);
            }

            if (todo.reminders.length === 0 && target === "calendar") {
                console.error("This todo has no reminders to sync to calendar.");
                process.exit(1);
            }

            const count = await syncSingleTodo({ store, todo, target });
            console.log(chalk.green(`Synced ${count} item(s) to ${target} for ${todo.id}.`));
        });
}

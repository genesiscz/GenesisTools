import { findProjectRoot } from "@app/todo/lib/context";
import { TodoStore } from "@app/todo/lib/store";
import { type SyncTarget, syncTodo } from "@app/todo/lib/sync";
import { Command } from "commander";
import pc from "picocolors";

export function createSyncCommand(): Command {
    return new Command("sync")
        .description("Sync todos to Apple Calendar or Reminders")
        .argument("[id]", "Todo ID (required unless --all)")
        .requiredOption("--to <target>", "Sync target: calendar|reminders|both")
        .option("--all", "Sync all open todos with reminders")
        .action(async (id: string | undefined, opts: { to: string; all?: boolean }) => {
            const target = opts.to as SyncTarget;

            if (target !== "calendar" && target !== "reminders" && target !== "both") {
                console.error(`Invalid sync target: ${opts.to}. Use "calendar", "reminders", or "both".`);
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
                    const count = await syncTodo({ store, todo, target });

                    if (count > 0) {
                        console.log(pc.green(`  ✓ ${todo.id}: ${todo.title} (${count} synced)`));
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

            if (todo.reminders.length === 0 && target !== "reminders") {
                console.error("This todo has no reminders to sync to calendar.");
                process.exit(1);
            }

            const count = await syncTodo({ store, todo, target });
            console.log(pc.green(`Synced ${count} item(s) to ${target} for ${todo.id}.`));
        });
}

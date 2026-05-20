import { out } from "@app/logger";
import { findProjectRoot } from "@app/todo/lib/context";
import { TodoStore } from "@app/todo/lib/store";
import { countSynced, describeSyncFailures, type SyncTarget, syncSucceeded, syncTodo } from "@app/todo/lib/sync";
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
                out.error(`Invalid sync target: ${opts.to}. Use "calendar", "reminders", or "both".`);
                process.exit(1);
            }

            const projectRoot = findProjectRoot(process.cwd()) ?? process.cwd();
            const store = TodoStore.forProject(projectRoot);

            if (opts.all) {
                const todos = await store.list({ status: ["todo", "in-progress", "blocked"] });
                const withReminders = todos.filter((t) => t.reminders.length > 0);

                if (withReminders.length === 0) {
                    out.println("No open todos with reminders to sync.");
                    return;
                }

                let totalSynced = 0;
                const failed: { todoId: string; reasons: string[] }[] = [];

                for (const todo of withReminders) {
                    const result = await syncTodo({ store, todo, target });
                    const count = countSynced(result);

                    if (count > 0) {
                        out.println(pc.green(`  ✓ ${todo.id}: ${todo.title} (${count} synced)`));
                        totalSynced += count;
                    }

                    const reasons = describeSyncFailures(result);

                    if (reasons.length > 0) {
                        failed.push({ todoId: todo.id, reasons });

                        for (const r of reasons) {
                            out.error(pc.red(`  ✗ ${todo.id}: ${r}`));
                        }
                    }
                }

                out.println(`\nSynced ${totalSynced} item(s) to ${target}.`);

                if (failed.length > 0) {
                    out.error(pc.red(`SYNC_FAILED ${target}: ${failed.length} todo(s) had failures`));
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
                out.error(`Todo not found: ${id}`);
                process.exit(1);
            }

            if (todo.reminders.length === 0 && target !== "reminders") {
                out.error("This todo has no reminders to sync to calendar.");
                process.exit(1);
            }

            const result = await syncTodo({ store, todo, target });
            const count = countSynced(result);

            if (count > 0) {
                out.println(pc.green(`Synced ${count} item(s) to ${target} for ${todo.id}.`));
            }

            const failures = describeSyncFailures(result);

            if (failures.length > 0) {
                for (const line of failures) {
                    out.error(pc.red(`SYNC_FAILED ${target} ${todo.id}: ${line}`));
                }
            }

            if (!syncSucceeded(result)) {
                process.exitCode = 1;
            }
        });
}

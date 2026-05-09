import type { Command } from "commander";
import { getShopsDatabase } from "../db/ShopsDatabase";
import { runDbPruneHttp } from "../lib/db-prune";

export function registerDbPruneCommand(program: Command): void {
    const dbCmd =
        program.commands.find((c) => c.name() === "db") ?? program.command("db").description("Database admin");
    dbCmd
        .command("prune-http")
        .description("Delete http_requests rows older than N days (default 30)")
        .option("--days <n>", "Retention window in days", "30")
        .action(async (opts: { days: string }) => {
            const days = Number(opts.days ?? 30);
            const deleted = await runDbPruneHttp(getShopsDatabase(), days);
            console.log(`pruned ${deleted} http_requests rows older than ${days} days`);
        });
}

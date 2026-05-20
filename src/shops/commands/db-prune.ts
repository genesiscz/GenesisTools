import { out } from "@app/logger";
import { getShopsDatabase } from "@app/shops/db/ShopsDatabase";
import { parsePositiveInt } from "@app/shops/lib/cli-validators";
import { runDbPruneHttp } from "@app/shops/lib/db-prune";
import type { Command } from "commander";

export function registerDbPruneCommand(program: Command): void {
    const dbCmd =
        program.commands.find((c) => c.name() === "db") ?? program.command("db").description("Database admin");
    dbCmd
        .command("prune-http")
        .description("Delete http_requests rows older than N days (default 30)")
        .option("--days <n>", "Retention window in days", parsePositiveInt("--days"), 30)
        .action(async (opts: { days: number }) => {
            const days = opts.days;
            const deleted = await runDbPruneHttp(getShopsDatabase(), days);
            out.print(`pruned ${deleted} http_requests rows older than ${days} days`);
        });
}

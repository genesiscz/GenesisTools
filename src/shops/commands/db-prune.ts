import logger from "@app/logger";
import type { Command } from "commander";
import { getShopsDatabase, type ShopsDatabase } from "../db/ShopsDatabase";

const log = logger.child({ component: "shops:db-prune" });

export async function runDbPruneHttp(db: ShopsDatabase, days = 30): Promise<number> {
    const result = db.raw().run(`DELETE FROM http_requests WHERE ts < datetime('now', ?)`, [`-${days} days`]);
    const changes = Number(result.changes ?? 0);
    log.info({ deletedRows: changes, retentionDays: days }, "http_requests pruned");
    return changes;
}

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

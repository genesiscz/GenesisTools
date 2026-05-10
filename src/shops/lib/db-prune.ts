import logger from "@app/logger";
import type { ShopsDatabase } from "@app/shops/db/ShopsDatabase";

const log = logger.child({ component: "shops:db-prune" });

export async function runDbPruneHttp(db: ShopsDatabase, days = 30): Promise<number> {
    const result = db.raw().run(`DELETE FROM http_requests WHERE ts < datetime('now', ?)`, [`-${days} days`]);
    const changes = Number(result.changes ?? 0);
    log.info({ deletedRows: changes, retentionDays: days }, "http_requests pruned");
    return changes;
}

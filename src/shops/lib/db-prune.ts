import { sql } from "kysely";
import logger from "@app/logger";
import type { ShopsDatabase } from "@app/shops/db/ShopsDatabase";

const log = logger.child({ component: "shops:db-prune" });

export async function runDbPruneHttp(db: ShopsDatabase, days = 30): Promise<number> {
    const result = await db
        .kysely()
        .deleteFrom("http_requests")
        .where("ts", "<", sql<string>`datetime('now', ${`-${days} days`})`)
        .executeTakeFirst();
    const changes = Number(result.numDeletedRows ?? 0);
    log.info({ deletedRows: changes, retentionDays: days }, "http_requests pruned");
    return changes;
}

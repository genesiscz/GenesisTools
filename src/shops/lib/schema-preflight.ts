import logger from "@app/logger";
import type { ShopsDatabase } from "../db/ShopsDatabase";

const log = logger.child({ component: "shops:schema-preflight" });

interface ColumnInfo {
    name: string;
    type: string;
    notnull: number;
}

const REQUIRED_NOTIFICATION_COLUMNS = [
    "delivered_macos_at",
    "delivered_web_at",
    "delivered_telegram_at",
    "delivery_error",
] as const;

const REQUIRED_TABLES = ["favorites", "notifications", "brand_aliases", "http_requests"] as const;

export function assertSchemaCompatible(db: ShopsDatabase): void {
    const raw = db.raw();

    for (const table of REQUIRED_TABLES) {
        const row = raw
            .query<{ name: string }, [string]>("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
            .get(table);
        if (!row) {
            throw new Error(
                `Plan 01 schema is missing table "${table}". Re-run shops migration or update Plan 01 before continuing.`
            );
        }
    }

    const notifCols = raw.query<ColumnInfo, []>("PRAGMA table_info(notifications)").all();
    const notifColNames = new Set(notifCols.map((c) => c.name));
    for (const col of REQUIRED_NOTIFICATION_COLUMNS) {
        if (!notifColNames.has(col)) {
            throw new Error(
                `notifications.${col} is missing. Plan 02 requires the typed delivery columns from Spec §Data model #9; ` +
                    `migration 001-initial must define them. Update Plan 01 first.`
            );
        }
    }

    const favCols = raw.query<ColumnInfo, []>("PRAGMA table_info(favorites)").all();
    const masterCol = favCols.find((c) => c.name === "master_product_id");
    if (!masterCol) {
        throw new Error("favorites.master_product_id is missing. Plan 02 requires it per Spec §Data model #8.");
    }

    if (masterCol.notnull !== 1) {
        throw new Error(
            "favorites.master_product_id must be declared NOT NULL per Spec §Data model #8. " +
                "Plan 01 schema is out-of-date — update migration 001-initial."
        );
    }

    log.debug("schema preflight passed");
}

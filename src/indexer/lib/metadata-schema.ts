import type { Database } from "bun:sqlite";
import logger from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import type { IndexerSource, MetadataPopulateOpts } from "./sources/source";
import type { MetadataColumnSpec } from "./types";

const COL_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertColumnName(name: string): void {
    if (!COL_RE.test(name)) {
        throw new Error(`Invalid column name: "${name}" (must match ${COL_RE.source})`);
    }
}

/**
 * Coerce a source-supplied metadata value into something bun:sqlite can bind.
 * Booleans become 0/1, Dates become epoch ms, anything else non-scalar drops to NULL.
 * Shared between insertChunks (live writes) and backfillMetadataColumns (column-add catchup).
 */
export function coerceMetadataValue(value: unknown): string | number | null {
    if (value === null || value === undefined) {
        return null;
    }

    if (typeof value === "string" || typeof value === "number") {
        return value;
    }

    if (typeof value === "boolean") {
        return value ? 1 : 0;
    }

    if (value instanceof Date) {
        return value.getTime();
    }

    return null;
}

/**
 * Diff declared metadata columns against persisted metadata columns and apply
 * the differences via ALTER TABLE + CREATE INDEX. Idempotent.
 *
 * - New columns: ALTER TABLE ADD COLUMN; if indexed, CREATE INDEX.
 * - Type-changed columns: throw — sources must use a new column name.
 * - Removed columns: NO-OP. Column stays; harmless.
 */
export function applySourceMetadataSchema(
    db: Database,
    tableName: string,
    declared: MetadataColumnSpec[],
    persisted: MetadataColumnSpec[]
): { added: string[]; indexed: string[] } {
    for (const c of declared) {
        assertColumnName(c.name);
    }

    const persistedByName = new Map(persisted.map((c) => [c.name, c]));
    const tableInfo = db.query(`PRAGMA table_info(${tableName}_content)`).all() as Array<{
        name: string;
        type: string;
    }>;
    const existingCols = new Map(tableInfo.map((r) => [r.name, r.type.toUpperCase()]));
    const existingIndexes = new Set(
        (
            db
                .query(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='${tableName}_content'`)
                .all() as Array<{
                name: string;
            }>
        ).map((r) => r.name)
    );

    const added: string[] = [];
    const indexed: string[] = [];

    for (const col of declared) {
        const prev = persistedByName.get(col.name);

        if (prev && prev.type !== col.type) {
            throw new Error(
                `Cannot change type of metadata column "${col.name}" from ${prev.type} to ${col.type}. Use a new column name or run a manual rebuild.`
            );
        }

        const idxName = `idx_${tableName}_content_${col.name}`;

        if (existingCols.has(col.name)) {
            if (col.indexed && !existingIndexes.has(idxName)) {
                db.run(`CREATE INDEX IF NOT EXISTS ${idxName} ON ${tableName}_content(${col.name})`);
                indexed.push(col.name);
            }
            continue;
        }

        const parts = [`ALTER TABLE ${tableName}_content ADD COLUMN ${col.name} ${col.type}`];

        if (col.notNull) {
            parts.push("NOT NULL");
        }

        if (col.default !== undefined) {
            const lit = typeof col.default === "string" ? `'${col.default.replace(/'/g, "''")}'` : col.default;
            parts.push(`DEFAULT ${lit}`);
        }

        db.run(parts.join(" "));
        added.push(col.name);

        if (col.indexed && !existingIndexes.has(idxName)) {
            db.run(`CREATE INDEX IF NOT EXISTS ${idxName} ON ${tableName}_content(${col.name})`);
            indexed.push(col.name);
        }
    }

    if (added.length > 0 || indexed.length > 0) {
        logger.info(
            `[indexer:metadata] added ${added.length} columns to ${tableName}_content` +
                (added.length > 0 ? `: ${added.join(", ")}` : "") +
                (indexed.length > 0 ? ` (indexed: ${indexed.join(", ")})` : "")
        );
    }

    return { added, indexed };
}

const PAGE_SIZE = 5000;
const BATCH_SIZE = 1000;

/**
 * Populate newly added metadata columns for all existing rows by calling the
 * source's `populateMetadata` generator. Skips columns the source returns no
 * value for (column stays NULL).
 *
 * Pages distinct source_ids out of the content table so we never hold the
 * full row set in memory. UPDATEs target every chunk that shares a source_id
 * (mail/chat sources can produce many chunks per message).
 *
 * Returns the number of rows touched.
 */
export async function backfillMetadataColumns(
    db: Database,
    tableName: string,
    source: IndexerSource,
    columns: MetadataColumnSpec[]
): Promise<number> {
    if (columns.length === 0 || !source.populateMetadata) {
        return 0;
    }

    for (const c of columns) {
        assertColumnName(c.name);
    }

    const declaredNames = new Set(columns.map((c) => c.name));
    const pageSql = `SELECT DISTINCT source_id, COALESCE(metadata_json, '{}') AS metadata_json FROM ${tableName}_content WHERE (? IS NULL OR source_id > ?) ORDER BY source_id LIMIT ${PAGE_SIZE}`;

    let cursor: string | null = null;
    let touched = 0;

    while (true) {
        const page = db.query(pageSql).all(cursor, cursor) as Array<{ source_id: string; metadata_json: string }>;

        if (page.length === 0) {
            break;
        }

        cursor = page[page.length - 1].source_id;

        const existingBagBySourceId = new Map<string, Record<string, unknown>>(
            page.map((r) => [
                r.source_id,
                typeof r.metadata_json === "string" ? (SafeJSON.parse(r.metadata_json) as Record<string, unknown>) : {},
            ])
        );

        const opts: MetadataPopulateOpts = {
            entries: page.map((r) => ({ sourceId: r.source_id })),
            batchSize: BATCH_SIZE,
        };

        for await (const batch of source.populateMetadata(opts)) {
            const tx = db.transaction(() => {
                for (const { sourceId, metadata } of batch) {
                    const presentColumns = columns.filter((c) => Object.hasOwn(metadata, c.name));
                    const typedSetters = presentColumns.map((c) => `${c.name} = ?`);
                    const typedVals = presentColumns.map((c) => coerceMetadataValue(metadata[c.name]));
                    const bag: Record<string, unknown> = { ...(existingBagBySourceId.get(sourceId) ?? {}) };

                    for (const k of Object.keys(metadata)) {
                        if (!declaredNames.has(k)) {
                            bag[k] = metadata[k];
                        }
                    }

                    const setClause = [...typedSetters, "metadata_json = ?"].join(", ");
                    const updateSql = `UPDATE ${tableName}_content SET ${setClause} WHERE source_id = ?`;
                    const params: Array<string | number | null> = [...typedVals, SafeJSON.stringify(bag), sourceId];
                    const result = db.run(updateSql, params);
                    touched += Number(result.changes ?? 0);
                }
            });
            tx();
        }

        logger.info(`[indexer:metadata] backfilled ${touched} rows in ${tableName}_content`);
    }

    return touched;
}

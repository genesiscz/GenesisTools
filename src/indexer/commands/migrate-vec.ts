import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import logger from "@app/logger";
import { isInteractive } from "@app/utils/cli";
import { formatDuration } from "@app/utils/format";
import { SafeJSON } from "@app/utils/json";
import { ensureExtensionCapableSQLite, loadSqliteVec } from "@app/utils/search/stores/sqlite-vec-loader";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";
import { getIndexerStorage, sanitizeName } from "../lib/storage";

export function registerMigrateVecCommand(program: Command): void {
    program
        .command("migrate-vec")
        .description("Migrate vector storage from brute-force blobs to sqlite-vec (faster KNN search)")
        .argument("[name]", "Index name")
        .option("--dry-run", "Show what would be migrated without writing")
        .action(async (name?: string, options?: { dryRun?: boolean }) => {
            const storage = getIndexerStorage();
            const configPath = storage.getConfigPath();

            if (!existsSync(configPath)) {
                p.log.error("No indexes configured.");
                return;
            }

            let targetName = name;

            if (!targetName) {
                const config = SafeJSON.parse(readFileSync(configPath, "utf-8")) as {
                    indexes: Record<string, unknown>;
                };
                const names = Object.keys(config.indexes ?? {});

                if (names.length === 0) {
                    p.log.info("No indexes found.");
                    return;
                }

                if (isInteractive()) {
                    const selected = await p.select({
                        message: "Select index to migrate",
                        options: names.map((n) => ({ value: n, label: n })),
                    });

                    if (p.isCancel(selected)) {
                        return;
                    }

                    targetName = selected;
                } else {
                    p.log.error("Index name required in non-interactive mode.");
                    process.exit(1);
                }
            }

            const indexDir = storage.getIndexDir(targetName);
            const dbPath = join(indexDir, "index.db");

            if (!existsSync(dbPath)) {
                p.log.error(`Index "${targetName}" database not found at ${dbPath}`);
                return;
            }

            const tableName = sanitizeName(targetName);
            const embTable = `${tableName}_embeddings`;
            const vecTable = `${tableName}_vec`;

            // Must be called BEFORE any Database() — swaps to extension-capable SQLite
            ensureExtensionCapableSQLite();

            const db = new Database(dbPath);

            try {
                const hasEmbTable = !!db
                    .query("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
                    .get(embTable);
                const hasVecTable = !!db
                    .query("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
                    .get(vecTable);

                if (hasVecTable) {
                    const vecCount = (db.query(`SELECT COUNT(*) AS cnt FROM ${vecTable}`).get() as { cnt: number }).cnt;
                    p.log.info(`Index "${targetName}" already uses sqlite-vec (${vecCount.toLocaleString()} vectors).`);
                    return;
                }

                if (!hasEmbTable) {
                    p.log.info(`Index "${targetName}" has no embeddings to migrate.`);
                    return;
                }

                const embCount = (db.query(`SELECT COUNT(*) AS cnt FROM ${embTable}`).get() as { cnt: number }).cnt;

                if (embCount === 0) {
                    p.log.info(`Index "${targetName}" has 0 embeddings — nothing to migrate.`);
                    return;
                }

                // Detect dimensions from first non-empty embedding
                const sample = db
                    .query(`SELECT embedding FROM ${embTable} WHERE length(embedding) > 0 LIMIT 1`)
                    .get() as { embedding: Buffer } | null;

                if (!sample) {
                    p.log.error("Could not read a valid embedding sample.");
                    return;
                }

                const dimensions = sample.embedding.byteLength / 4; // Float32 = 4 bytes

                p.intro(pc.bgCyan(pc.white(` migrate-vec ${targetName} `)));
                p.log.info(
                    `Found ${pc.bold(embCount.toLocaleString())} embeddings (${dimensions}d) in brute-force table.\n` +
                        `Migration will:\n` +
                        `  1. Load sqlite-vec extension\n` +
                        `  2. Create ${vecTable} virtual table (vec0)\n` +
                        `  3. Copy all embeddings from ${embTable} → ${vecTable}\n` +
                        `  4. Drop old ${embTable} table\n` +
                        `\nAfter migration, vector search uses optimized C-level KNN instead of JS brute-force.`
                );

                if (options?.dryRun) {
                    p.log.info("Dry run — no changes made.");
                    return;
                }

                if (isInteractive()) {
                    const confirmed = await p.confirm({
                        message: `Migrate ${embCount.toLocaleString()} vectors to sqlite-vec?`,
                    });

                    if (p.isCancel(confirmed) || !confirmed) {
                        p.log.info("Cancelled.");
                        return;
                    }
                }

                const vecLoaded = loadSqliteVec(db);

                if (!vecLoaded) {
                    p.log.error("Failed to load sqlite-vec extension. Install: bun add sqlite-vec");
                    return;
                }

                const spinner = p.spinner();
                spinner.start("Migrating embeddings...");
                const startMs = performance.now();

                db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS ${vecTable} USING vec0(
                    doc_id TEXT PRIMARY KEY,
                    embedding float[${dimensions}] distance_metric=cosine
                )`);

                const BATCH_SIZE = 1000;
                let migrated = 0;
                let offset = 0;

                while (true) {
                    const batch = db
                        .query(`SELECT doc_id, embedding FROM ${embTable} LIMIT ? OFFSET ?`)
                        .all(BATCH_SIZE, offset) as Array<{ doc_id: string; embedding: Buffer }>;

                    if (batch.length === 0) {
                        break;
                    }

                    const tx = db.transaction(() => {
                        for (const row of batch) {
                            // Skip zero-length marker blobs (Qdrant placeholders)
                            if (row.embedding.byteLength === 0) {
                                continue;
                            }

                            const blob = new Uint8Array(
                                row.embedding.buffer,
                                row.embedding.byteOffset,
                                row.embedding.byteLength
                            );
                            db.run(`INSERT INTO ${vecTable}(doc_id, embedding) VALUES (?, ?)`, [row.doc_id, blob]);
                            migrated++;
                        }
                    });
                    tx();

                    offset += batch.length;
                    spinner.message(`Migrated ${migrated.toLocaleString()} / ${embCount.toLocaleString()} vectors...`);
                }

                // Drop old brute-force table
                db.run(`DROP TABLE ${embTable}`);

                const durationMs = performance.now() - startMs;
                spinner.stop("Migration complete");

                p.log.success(
                    `${pc.bold(migrated.toLocaleString())} vectors migrated to sqlite-vec in ${formatDuration(durationMs)}`
                );

                logger.info(
                    `[migrate-vec] ${targetName}: ${migrated} vectors (${dimensions}d) migrated in ${durationMs.toFixed(0)}ms`
                );

                p.outro("Done — search will now use optimized KNN.");
            } finally {
                db.close();
            }
        });
}

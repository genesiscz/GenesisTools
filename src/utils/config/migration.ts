import logger from "@app/logger";
import { Storage } from "@app/utils/storage/storage";

export interface ConfigMigration {
    /** Unique ID -- format: "YYYY-MM-DD-description" */
    id: string;
    /** Human-readable description */
    description: string;
    /** Returns true if this migration needs to run (target config is missing/outdated) */
    shouldRun: () => Promise<boolean>;
    /** Execute the migration. Responsible for its own atomicity (use Storage locks). */
    run: () => Promise<void>;
}

interface MigrationRecord {
    completed: string[];
}

const migrationStorage = new Storage("migrations");

/**
 * Run all pending migrations in order.
 * Records completed migrations in ~/.genesis-tools/migrations/config.json
 * so they don't run twice.
 *
 * Idempotency is two-layered:
 *  1. Runner level: completed IDs in migrations.json skip re-execution.
 *  2. Migration level: each migration's shouldRun() checks target state.
 *
 * @returns List of migration IDs that were actually executed.
 */
export async function runMigrations(migrations: ConfigMigration[]): Promise<string[]> {
    const record = (await migrationStorage.getConfig<MigrationRecord>()) ?? { completed: [] };
    const executed: string[] = [];

    for (const migration of migrations) {
        // Always check shouldRun() — even if previously completed.
        // Migrations may bump their schema version (e.g. v2 → v3),
        // requiring a re-run despite the ID being in the completed list.
        let needsRun: boolean;

        try {
            needsRun = await migration.shouldRun();
        } catch (err) {
            logger.warn(`Migration "${migration.id}" shouldRun() failed, skipping: ${err}`);
            continue;
        }

        if (!needsRun) {
            // Target is already in the desired state — ensure it's recorded
            if (!record.completed.includes(migration.id)) {
                record.completed.push(migration.id);
                await migrationStorage.setConfig(record);
            }

            continue;
        }

        try {
            logger.info(`Running migration: ${migration.id} -- ${migration.description}`);
            await migration.run();
            record.completed.push(migration.id);
            await migrationStorage.setConfig(record);
            executed.push(migration.id);
            logger.info(`Migration complete: ${migration.id}`);
        } catch (err) {
            logger.error(`Migration "${migration.id}" failed: ${err}`);
            // Stop on failure -- don't run subsequent migrations that may depend on this one
            break;
        }
    }

    return executed;
}

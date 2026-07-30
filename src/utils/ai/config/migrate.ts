import { runMigrations } from "@genesiscz/utils/config/migration";
import { migrateAI } from "@genesiscz/utils/config/migrations/2026-04-07-migrateAI";
import { migrateConfigV4 } from "./migrations/2026-08-configV4";
import { migrateSecretsToVault } from "./migrations/2026-08-secretsToVault";

/**
 * The AI config migration chain, in dependency order: legacy consolidation,
 * then v4 shape, then credentials into the vault.
 *
 * `migrateSeedEnvAccounts` is deliberately NOT here. Seeding creates an account
 * per environment-resolved provider, which is a rollout decision the user
 * reviews (the grandfather list) rather than something that should appear in
 * their config the first time any tool happens to read it. Phase 2 runs it
 * explicitly.
 *
 * Both entry points (`AiConfigStore.load` and the deprecated `AIConfig.load`)
 * run this, so reaching the config through either one cannot land on a shape the
 * reader does not understand. Each migration is individually idempotent and
 * guarded, so running it on every load costs a stat and nothing else.
 */
let migrated = false;

export async function ensureAiConfigMigrated(): Promise<void> {
    if (migrated) {
        return;
    }

    await runMigrations([migrateAI, migrateConfigV4, migrateSecretsToVault]);
    migrated = true;
}

/** Test seam: the chain is process-scoped, and tests switch config roots. */
export function _resetMigrationStateForTest(): void {
    migrated = false;
}

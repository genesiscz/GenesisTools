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
 * their config the first time any tool happens to read it.
 *
 * ⚠️ NOTHING calls it today. An earlier version of this comment said "Phase 2
 * runs it explicitly", which was never true and would mislead a reader into
 * assuming seeded accounts already exist. The behaviour it was meant to protect
 * is delivered a different way: `ephemeralEnvAccounts` (same file) synthesises
 * the accounts IN MEMORY at resolution time, so a machine whose only credential
 * for a provider is an environment variable still resolves. It is consumed by
 * `core/resolve.ts`, `core/choose.ts` and `ask/providers/ProviderManager.ts`.
 * What is still missing is the visible half: those variables never become
 * reviewable entries in the user's config.
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

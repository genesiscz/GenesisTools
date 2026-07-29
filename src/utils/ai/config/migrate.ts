import { runMigrations } from "@genesiscz/utils/config/migration";
import { migrateAI } from "@genesiscz/utils/config/migrations/2026-04-07-migrateAI";
import { logger } from "@genesiscz/utils/logger";
import { migrationAllowedHere } from "./migration-guard";
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

const CHAIN = [migrateAI, migrateConfigV4, migrateSecretsToVault];

export async function ensureAiConfigMigrated(): Promise<void> {
    if (migrated) {
        return;
    }

    // The guard is applied to the WHOLE chain, not just to the members that
    // carry it themselves. `migrateAI` has no gate of its own, so a worktree
    // build reading a real v1/v2 config would rewrite it to v3 and only then hit
    // the guarded v4 step, which is exactly the write this guard exists to
    // refuse. Each migration keeps its own gate as well: two independent checks
    // are what stop a bug in one from reaching the user's real file.
    if (!migrationAllowedHere()) {
        migrated = true;
        return;
    }

    await runMigrations(CHAIN);

    // `runMigrations` logs a failing migration, stops the chain and resolves
    // normally, so nothing it returns distinguishes "all done" from "step two
    // threw". Latching the process guard on that left a half-migrated config
    // (plaintext credentials still in the file) with every later load in this
    // process skipping the retry. Re-asking each migration costs a stat apiece.
    migrated = !(await chainStillPending());
}

async function chainStillPending(): Promise<boolean> {
    for (const migration of CHAIN) {
        try {
            if (await migration.shouldRun()) {
                return true;
            }
        } catch (err) {
            logger.debug({ err, migration: migration.id }, "shouldRun threw while confirming the chain finished");
            return true;
        }
    }

    return false;
}

/** Test seam: the chain is process-scoped, and tests switch config roots. */
export function _resetMigrationStateForTest(): void {
    migrated = false;
}

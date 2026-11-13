import { migrateAI } from "@genesiscz/utils/config/migrations/2026-04-07-migrateAI";
import { mayPersistMigration } from "@genesiscz/utils/config/real-home-write";
import { logger } from "@genesiscz/utils/logger";
import { Storage } from "@genesiscz/utils/storage/storage";
import { migrateConfigV4 } from "./migrations/2026-08-configV4";
import { migrateSecretsToVault } from "./migrations/2026-08-secretsToVault";
import { CONFIG_VERSION } from "./schema";

/** One step of the AI config chain. Each step checks its own target state, so running it twice is a no-op. */
export interface ConfigMigration {
    /** Unique ID, format "YYYY-MM-DD-description". */
    id: string;
    description: string;
    /**
     * True when the target config is missing or behind. `"deferred"` when it is behind but this process cannot bring
     * it forward now (the vault step in a non-interactive process without a master key): the chain then does not count
     * as finished, and a later load in the same process asks again.
     */
    shouldRun: () => Promise<boolean | "deferred">;
    /** Responsible for its own atomicity (Storage locks). */
    run: () => Promise<void>;
}

/** A step that threw, from its `shouldRun` or its `run`. */
export interface MigrationFailure {
    id: string;
    phase: "shouldRun" | "run";
    error: unknown;
}

export const MIGRATION_SKIPPED_MESSAGE =
    "skipping AI config migration: the real config is shared with the installed tools and this process may not write it. Set GENESIS_TOOLS_ALLOW_REAL_MIGRATION=1 to override.";

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
 * `AiConfigStore.load` runs this (the retired v3 facade did too), so reaching the
 * config through any entry point cannot land on a shape the
 * reader does not understand. Each migration is individually idempotent and
 * guarded, so running it on every load costs a stat and nothing else.
 */
/**
 * The config path the chain last finished for, or null. Keyed by path, not a plain flag: a process whose
 * GENESIS_TOOLS_HOME moves (a test, a sandboxed run) has a different config that the chain has not seen.
 */
let migratedFor: string | null = null;

/**
 * The config path a step deferred on, and when. A deferral is no completion: the process asks again once
 * `DEFERRED_RETRY_MS` has passed, so a master key that becomes reachable later still moves the credentials.
 */
let deferredFor: { path: string; at: number } | null = null;

/** How long a deferred chain waits before it asks again; each ask reads the key ladder and logs the deferral. */
const DEFERRED_RETRY_MS = 5 * 60_000;

function currentConfigPath(): string {
    return new Storage("ai").getConfigPath();
}

const CHAIN = [migrateAI, migrateConfigV4, migrateSecretsToVault];

/**
 * Runs the chain once for the current config path and returns the steps that failed. An empty list after a
 * real run latches the process guard; a failure leaves it open, so the next load retries.
 */
export async function ensureAiConfigMigrated(): Promise<MigrationFailure[]> {
    const configPath = currentConfigPath();
    if (migratedFor === configPath) {
        return [];
    }

    if (deferredFor?.path === configPath && Date.now() - deferredFor.at < DEFERRED_RETRY_MS) {
        return [];
    }

    // The guard is applied to the WHOLE chain, not just to the members that
    // carry it themselves. `migrateAI` has no gate of its own, so a worktree
    // build reading a real v1/v2 config would rewrite it to v3 and only then hit
    // the guarded v4 step, which is exactly the write this guard exists to
    // refuse. Each migration keeps its own gate as well: two independent checks
    // are what stop a bug in one from reaching the user's real file.
    const verdict = mayPersistMigration();

    if (!verdict.allowed) {
        // Debug, not warn: every `tools` process started in a worktree asks this on its first config read,
        // almost always with nothing to migrate (420 warnings on 2026-09-29/30, all with a current config).
        // `warnIfConfigIsBehind` warns when a skipped migration was really due.
        logger.debug({ reason: verdict.reason }, MIGRATION_SKIPPED_MESSAGE);
        migratedFor = configPath;
        await warnIfConfigIsBehind(verdict.reason);
        return [];
    }

    const { failures, deferred } = await runChain();

    // Latching the process guard after a failed step left a half-migrated config (plaintext credentials
    // still in the file) with every later load in this process skipping the retry. A deferred step is not
    // finished either: it gets its own, timed retry.
    migratedFor = failures.length === 0 && deferred.length === 0 ? configPath : null;
    deferredFor = failures.length === 0 && deferred.length > 0 ? { path: configPath, at: Date.now() } : null;
    return failures;
}

/**
 * Runs each step whose `shouldRun` says yes, in order. A `shouldRun` that throws is skipped and reported; a
 * `run` that throws stops the chain, since the later steps may depend on it.
 */
async function runChain(): Promise<{ failures: MigrationFailure[]; deferred: string[] }> {
    const failures: MigrationFailure[] = [];
    const deferred: string[] = [];

    for (const migration of CHAIN) {
        let due: boolean | "deferred";

        try {
            due = await migration.shouldRun();
        } catch (error) {
            logger.warn({ err: error, migration: migration.id }, "AI config migration: shouldRun threw, skipping");
            failures.push({ id: migration.id, phase: "shouldRun", error });
            continue;
        }

        if (due === "deferred") {
            deferred.push(migration.id);
            continue;
        }

        if (!due) {
            continue;
        }

        try {
            logger.info(`Running migration: ${migration.id} -- ${migration.description}`);
            await migration.run();
            logger.info(`Migration complete: ${migration.id}`);
        } catch (error) {
            logger.error({ err: error, migration: migration.id }, "AI config migration failed, the chain stops");
            failures.push({ id: migration.id, phase: "run", error });
            break;
        }
    }

    return { failures, deferred };
}

/**
 * The guard only says a migration MAY not run here; this says whether one was due. The config's
 * version is the cheap tell: the members' own `shouldRun` cannot answer, since each asks the same
 * guard and says "no" in a worktree.
 */
async function warnIfConfigIsBehind(reason: string): Promise<void> {
    const raw = await new Storage("ai").getConfig<{ version?: number; _schemaVersion?: number }>();
    const version = raw?.version ?? raw?._schemaVersion;
    if (typeof version === "number" && version < CONFIG_VERSION) {
        logger.warn({ reason, version, current: CONFIG_VERSION }, MIGRATION_SKIPPED_MESSAGE);
    }
}

/** Test seam: the chain is process-scoped, and tests switch config roots. */
export function _resetMigrationStateForTest(): void {
    migratedFor = null;
    deferredFor = null;
}

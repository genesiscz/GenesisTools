import { chmodSync, copyFileSync, existsSync } from "node:fs";
import { isInteractive } from "@genesiscz/utils/cli";
import type { ConfigMigration } from "@genesiscz/utils/config/migration";
import { logger, out } from "@genesiscz/utils/logger";
import { isSecureRef, masterKeySync, secrets } from "@genesiscz/utils/security";
import { Storage } from "@genesiscz/utils/storage/storage";
import { migrationAllowedHere } from "../migration-guard";
import { type AccountCredentials, type AccountEntry, type AiConfigData, CONFIG_VERSION } from "../schema";

/** Credential fields whose values are secrets. `authFile` and `dataDir` are paths, not secrets. */
const SECRET_FIELDS = ["apiKey", "accessToken", "refreshToken", "longLivedToken"] as const;
const SECONDARY_SECRET_FIELDS = ["accessToken", "refreshToken"] as const;

export function vaultPathFor(accountId: string, field: string): string {
    return `ai/${accountId}/${field}`;
}

function hasPlaintext(account: AccountEntry): boolean {
    for (const field of SECRET_FIELDS) {
        if (typeof account.credentials[field] === "string") {
            return true;
        }
    }

    for (const field of SECONDARY_SECRET_FIELDS) {
        if (typeof account.credentials.secondary?.[field] === "string") {
            return true;
        }
    }

    return false;
}

export function configHasPlaintext(config: AiConfigData): boolean {
    return config.accounts.some(hasPlaintext);
}

function aiStorage(): Storage {
    return new Storage("ai");
}

export function backupPath(storage: Storage): string {
    return `${storage.getBaseDir()}/config.v3.plaintext.bak.json`;
}

/**
 * Where THIS run's plaintext copy goes.
 *
 * An existing backup is never overwritten and never reused. It holds the
 * plaintext of credentials that are already SecureRefs in the config on disk, so
 * copying the config again now would produce a file missing them, while reusing
 * the old one would miss whatever this run is about to move. Either way the
 * "only fallback if the master key is lost" promise below would be false. A run
 * that finds newly-added plaintext gets its own numbered file instead.
 */
function backupFor(storage: Storage): string {
    const base = backupPath(storage);

    if (!existsSync(base)) {
        return base;
    }

    const numbered = (n: number) => base.replace(/\.json$/, `.${n}.json`);
    let n = 2;

    while (existsSync(numbered(n))) {
        n += 1;
    }

    return numbered(n);
}

/**
 * Move every plaintext credential into the vault, leaving a SecureRef behind.
 *
 * A 0600 copy of the pre-migration config is kept, and the user is told about it
 * loudly: silently leaving a plaintext copy would defeat the exercise, and
 * silently deleting it would risk unrecoverable token loss if the vault turns
 * out to be unreadable on this machine.
 */
export const migrateSecretsToVault: ConfigMigration = {
    id: "2026-08-secretsToVault",
    description: "Move plaintext AI credentials into the encrypted vault",

    shouldRun: async () => {
        const raw = await aiStorage().getConfig<AiConfigData>();
        if (!raw || raw.version !== CONFIG_VERSION) {
            return false;
        }

        if (!migrationAllowedHere()) {
            return false;
        }

        if (!configHasPlaintext(raw)) {
            return false;
        }

        // A headless process (launchd, cron, CI) may have no reachable master key.
        // Deferring is right: the credentials keep working as they are, and the
        // next interactive run migrates them. Failing here would take the daemon
        // down over a hygiene task it cannot complete.
        if (!masterKeySync() && !isInteractive()) {
            logger.warn(
                "plaintext credentials are present but no vault master key is reachable in this non-interactive process; deferring"
            );
            return false;
        }

        return true;
    },

    run: async () => {
        const storage = aiStorage();
        const store = await secrets();
        let moved = 0;

        await storage.withConfigLock(async () => {
            const config = await storage.getConfig<AiConfigData>();
            if (!config || !configHasPlaintext(config)) {
                return;
            }

            const backup = backupFor(storage);
            copyFileSync(storage.getConfigPath(), backup);
            chmodSync(backup, 0o600);

            for (const account of config.accounts) {
                for (const field of SECRET_FIELDS) {
                    const value = account.credentials[field];
                    if (typeof value !== "string") {
                        continue;
                    }

                    const ref = await store.set(vaultPathFor(account.id, field), value);
                    (account.credentials as Record<string, unknown>)[field] = ref;
                    moved += 1;
                }

                const secondary = account.credentials.secondary;
                if (!secondary) {
                    continue;
                }

                for (const field of SECONDARY_SECRET_FIELDS) {
                    const value = secondary[field];
                    if (typeof value !== "string") {
                        continue;
                    }

                    const ref = await store.set(vaultPathFor(account.id, `secondary.${field}`), value);
                    (secondary as Record<string, unknown>)[field] = ref;
                    moved += 1;
                }
            }

            await storage.setConfig(config);
            chmodSync(storage.getConfigPath(), 0o600);

            logger.info({ moved, backup }, "moved plaintext credentials into the vault");
            out.log.warn(
                [
                    `Moved ${moved} credential(s) into the encrypted vault.`,
                    `A plaintext copy of the previous config is at ${backup} (mode 0600).`,
                    "Delete it once everything works: it, plus any earlier numbered copies beside it, are the only fallback if the vault master key is lost.",
                ].join("\n")
            );
        });
    },
};

export function credentialIsVaulted(credentials: AccountCredentials, field: (typeof SECRET_FIELDS)[number]): boolean {
    return isSecureRef(credentials[field]);
}

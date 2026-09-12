import { unlinkSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import { vaultPathFor } from "@genesiscz/utils/ai/config/migrations/2026-08-secretsToVault";
import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";
import { grokRoot } from "@genesiscz/utils/grok/worker-paths";
import { logger } from "@genesiscz/utils/logger";
import { masterKey, resolveSecret, type SecureRef, secrets } from "@genesiscz/utils/security";
import { NETWORKED_LOCK_WAIT_MS } from "@genesiscz/utils/storage/file-lock";
import { decodeJwtClaims, getActiveAuthEntry, readAuthFile, readAuthFileAsync } from "./auth";
import { writeGrokAuthEntry } from "./auth-write";
import { resolveStoredGrokGrant } from "./stored-grant";

/**
 * A vault-only grok account (`tools grok login` without `--home` / `--auth-file`) has no
 * `auth.json` anywhere on disk, while the grok TUI authenticates from `GROK_AUTH_PATH`. The
 * launcher materialises the grant into a private file for the session's lifetime and syncs
 * whatever the CLI rotated back into the vault afterwards.
 *
 * The sync-back is not optional: the grok binary refreshes an expired token itself and
 * writes the result to that file ("auth: storing token", "auth update disk written" in its
 * strings), and an OIDC refresh token is single-use. Leaving the vault with the pre-session
 * refresh token would burn the grant the next time the usage poller refreshed it.
 */

export interface GrokGrantFileDeps {
    /** A fresh access token for the account, refreshed through the vault grant when expired. */
    resolveGrant(accountName: string): Promise<string>;
    resolveSecret: typeof resolveSecret;
    storeSecret(accountId: string, field: "accessToken" | "refreshToken", value: string): Promise<SecureRef>;
    loadStore(): Promise<{
        withLock<T>(fn: (data: { accounts: AccountEntry[] }) => Promise<T>, t?: number): Promise<T>;
    }>;
    /** Directory the per-account files live in. */
    dir(): string;
}

const defaultDeps: GrokGrantFileDeps = {
    resolveGrant: (name) => resolveStoredGrokGrant(name),
    resolveSecret,
    async storeSecret(accountId, field, value) {
        await masterKey();
        return (await secrets()).set(vaultPathFor(accountId, field), value);
    },
    loadStore: () => AiConfigStore.load(),
    dir: () => join(grokRoot(), "auth"),
};

/**
 * The signals that kill a CLI without running a `finally`. SIGKILL is absent on purpose:
 * it cannot be trapped, so the plaintext file can outlive the process no matter what this
 * module does. That residue is bounded by the 0600 file in a 0700 directory.
 */
const EXIT_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

export interface MaterialisedGrokGrant {
    authPath: string;
    /** Sync a rotated token back into the vault and remove the file. Always call it, even on a failed launch. */
    release(): Promise<"unchanged" | "synced" | "missing">;
}

/** Unix ms the token stops being valid, from its own `exp` claim; the stored value is the fallback. */
function expiryOf(token: string, stored: number | undefined): number {
    const exp = decodeJwtClaims(token)?.exp;

    if (typeof exp === "number" && Number.isFinite(exp)) {
        return exp * 1000;
    }

    return stored ?? Date.now() + 60 * 60 * 1000;
}

export async function materialiseGrokGrant(
    account: AccountEntry,
    deps: GrokGrantFileDeps = defaultDeps
): Promise<MaterialisedGrokGrant> {
    const accessToken = await deps.resolveGrant(account.name);
    const refreshToken = await deps.resolveSecret(account.credentials.refreshToken);
    // The pid keeps two concurrent sessions of ONE account off the same path. Sharing it
    // meant the first to exit unlinked the file out from under the second, and the
    // second then synced a grant it had not been given. Nothing reads this name: the
    // path travels to the TUI as GROK_AUTH_PATH.
    const authPath = join(deps.dir(), `${account.id}-${process.pid}.json`);

    // `writeGrokAuthEntry` creates the directory 0700 and the file 0600 through the atomic writer.
    await writeGrokAuthEntry(authPath, {
        accessToken,
        ...(refreshToken ? { refreshToken } : {}),
        expiresAt: expiryOf(accessToken, account.credentials.expiresAt),
    });
    logger.info({ account: account.name, authPath }, "grok: materialised the vault grant for a TUI session");

    /**
     * Sync whatever the CLI rotated back into the vault. Takes the entry rather than
     * reading it, so the signal path can read and delete the file synchronously first and
     * still sync from what it holds in memory.
     */
    const syncBack = async (active: ReturnType<typeof getActiveAuthEntry>) => {
        let status: "unchanged" | "synced" | "missing" = "unchanged";

        if (!active) {
            logger.warn({ account: account.name, authPath }, "grok: the materialised auth file lost its entry");
            status = "missing";
        } else if (active.key !== accessToken || (active.refresh_token ?? refreshToken) !== refreshToken) {
            const store = await deps.loadStore();

            await store.withLock(async (data) => {
                const current = data.accounts.find((entry) => entry.id === account.id);

                if (!current) {
                    logger.warn({ account: account.name }, "grok: account vanished during the session; not synced");
                    return;
                }

                current.credentials.accessToken = await deps.storeSecret(current.id, "accessToken", active.key);

                if (active.refresh_token) {
                    current.credentials.refreshToken = await deps.storeSecret(
                        current.id,
                        "refreshToken",
                        active.refresh_token
                    );
                }

                const expiresAt = active.expires_at ? Date.parse(active.expires_at) : Number.NaN;
                current.credentials.expiresAt = Number.isFinite(expiresAt)
                    ? expiresAt
                    : expiryOf(active.key, undefined);
            }, NETWORKED_LOCK_WAIT_MS);
            logger.info({ account: account.name }, "grok: synced the token the CLI rotated back into the vault");
            status = "synced";
        }

        return status;
    };

    let finished = false;

    const stopWatching = (): void => {
        for (const signal of EXIT_SIGNALS) {
            process.off(signal, onSignal);
        }
    };

    /**
     * A SIGTERM, SIGHUP or Ctrl-C skips the launcher's `finally`, and without this the
     * plaintext grant stayed on disk AND the vault kept the pre-session refresh token —
     * which an OIDC provider invalidates the moment the CLI rotates it, so the next
     * poller refresh burned the grant.
     *
     * Read and delete synchronously: the process is on its way out, and the file is the
     * part that must not survive. The vault sync then runs from memory, and the signal is
     * re-raised afterwards so the normal exit status still reaches the parent.
     */
    function onSignal(signal: NodeJS.Signals): void {
        stopWatching();

        // Re-raising the signal on ourselves is how a handler restores the default
        // disposition, so the exit status the parent sees is the one the signal would have
        // produced on its own.
        const reRaise = (): void => {
            // pid-verified: our OWN pid, never read from durable state, so it cannot be recycled.
            process.kill(process.pid, signal);
        };

        if (finished) {
            reRaise();
            return;
        }

        finished = true;
        const active = getActiveAuthEntry(readAuthFile(authPath));
        removeAuthFileSync();

        void syncBack(active)
            .catch((error: unknown) => {
                logger.error({ error, account: account.name, signal }, "grok: could not sync the rotated token");
            })
            .finally(reRaise);
    }

    function removeAuthFileSync(): void {
        try {
            unlinkSync(authPath);
        } catch (error) {
            logger.debug({ error, authPath }, "grok: materialised auth file already gone");
        }
    }

    for (const signal of EXIT_SIGNALS) {
        process.on(signal, onSignal);
    }

    return {
        authPath,
        async release() {
            stopWatching();

            if (finished) {
                return "missing";
            }

            finished = true;
            const active = getActiveAuthEntry(await readAuthFileAsync(authPath));

            // Delete before syncing, not after: the token is already in memory, so every
            // extra millisecond the plaintext file exists buys nothing.
            await unlink(authPath).catch((error: unknown) => {
                logger.debug({ error, authPath }, "grok: materialised auth file already gone");
            });

            return await syncBack(active);
        },
    };
}

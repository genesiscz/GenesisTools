import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import { vaultPathFor } from "@genesiscz/utils/ai/config/migrations/2026-08-secretsToVault";
import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";
import { grokRoot } from "@genesiscz/utils/grok/worker-paths";
import { logger } from "@genesiscz/utils/logger";
import { masterKey, resolveSecret, type SecureRef, secrets } from "@genesiscz/utils/security";
import { NETWORKED_LOCK_WAIT_MS } from "@genesiscz/utils/storage/file-lock";
import { decodeJwtClaims, getActiveAuthEntry, readAuthFileAsync } from "./auth";
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
    const authPath = join(deps.dir(), `${account.id}.json`);

    // `writeGrokAuthEntry` creates the directory 0700 and the file 0600 through the atomic writer.
    await writeGrokAuthEntry(authPath, {
        accessToken,
        ...(refreshToken ? { refreshToken } : {}),
        expiresAt: expiryOf(accessToken, account.credentials.expiresAt),
    });
    logger.info({ account: account.name, authPath }, "grok: materialised the vault grant for a TUI session");

    return {
        authPath,
        async release() {
            const active = getActiveAuthEntry(await readAuthFileAsync(authPath));
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

            await unlink(authPath).catch((error: unknown) => {
                logger.debug({ error, authPath }, "grok: materialised auth file already gone");
            });

            return status;
        },
    };
}

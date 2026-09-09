import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import { vaultPathFor } from "@genesiscz/utils/ai/config/migrations/2026-08-secretsToVault";
import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";
import { logger } from "@genesiscz/utils/logger";
import { masterKey, resolveSecret, type SecureRef, secrets } from "@genesiscz/utils/security";
import { NETWORKED_LOCK_WAIT_MS } from "@genesiscz/utils/storage/file-lock";
import { decodeJwtClaims, isTokenExpired } from "./auth";
import { GrokAuthExpiredError } from "./auth-errors";
import { type GrokTokens, grokOAuth } from "./oauth";

/** The two things this needs from `AiConfigStore`; a test hands in an in-memory one. */
export interface StoredGrantStore {
    account(selector: string): AccountEntry | undefined;
    withLock<T>(fn: (data: { accounts: AccountEntry[] }) => Promise<T>, timeout?: number): Promise<T>;
}

/** What the resolver needs from the config and the vault. Tests substitute all of it. */
export interface StoredGrokGrantDeps {
    loadStore(allowWrite: boolean): Promise<StoredGrantStore>;
    resolveSecret: typeof resolveSecret;
    storeSecret(accountId: string, field: "accessToken" | "refreshToken", value: string): Promise<SecureRef>;
    refresh(refreshToken: string): Promise<GrokTokens>;
}

const defaultDeps: StoredGrokGrantDeps = {
    loadStore: (allowWrite) => (allowWrite ? AiConfigStore.load() : AiConfigStore.readOnly()),
    resolveSecret,
    async storeSecret(accountId, field, value) {
        // A legacy plaintext grant must not be spent before vault encryption is available.
        await masterKey();

        return (await secrets()).set(vaultPathFor(accountId, field), value);
    },
    refresh: (refreshToken) => grokOAuth.refresh(refreshToken),
};

export interface ResolveStoredGrokGrantOptions {
    /** Diagnosis: read the stored token, never perform the refresh grant. */
    noRefresh?: boolean;
    /** The upstream just rejected the token: refresh even though `exp` says it is fine. */
    force?: boolean;
    deps?: Partial<StoredGrokGrantDeps>;
}

function requireGrokAccount(account: AccountEntry | undefined, name: string): AccountEntry {
    if (account?.provider !== "grok-sub") {
        throw new Error(`Account "${name}" is not a grok-sub account`);
    }

    return account;
}

/**
 * The access token of a grok-sub account whose grant lives in the vault (a `tools grok
 * login` without `--home` or `--auth-file`), refreshed through xAI's OIDC issuer when it
 * has expired. Nothing here reads the Grok CLI's own auth file: that file belongs to
 * whoever ran `grok login`, which is not necessarily this account.
 *
 * The refresh runs INSIDE the config lock, the way `CodexAccountBinding` does it. A refresh
 * token is single-use, and the usage daemon, a TUI and ai-proxy all resolve the same account,
 * so the loser of a race re-reads inside the lock, finds the token the winner just stored,
 * and spends nothing.
 */
export async function resolveStoredGrokGrant(
    accountName: string,
    options: ResolveStoredGrokGrantOptions = {}
): Promise<string> {
    const deps: StoredGrokGrantDeps = { ...defaultDeps, ...options.deps };
    const store = await deps.loadStore(!options.noRefresh);
    const account = requireGrokAccount(store.account(accountName), accountName);
    const hint = `Run: tools grok login ${account.name}`;
    const token = await deps.resolveSecret(account.credentials.accessToken);

    if (!token) {
        throw new Error(`Account "${account.name}" holds no stored grok token. ${hint}`);
    }

    if (!options.force && !isTokenExpired(decodeJwtClaims(token))) {
        return token;
    }

    // Guard above the consuming call: the grant below rotates a single-use refresh token,
    // which a diagnosis must never do.
    if (options.noRefresh) {
        throw new Error(
            `The stored grok-sub token of "${account.name}" is expired and the OIDC refresh is disabled ` +
                `for diagnosis. ${hint}`
        );
    }

    return store.withLock(async (data) => {
        const current = requireGrokAccount(
            data.accounts.find((entry) => entry.id === account.id),
            account.name
        );
        const latest = await deps.resolveSecret(current.credentials.accessToken);

        // Another process refreshed while this one waited for the lock: its token is the
        // one the issuer now expects, and spending our refresh token would burn the family.
        if (latest && latest !== token && !isTokenExpired(decodeJwtClaims(latest))) {
            return latest;
        }

        const refreshToken = await deps.resolveSecret(current.credentials.refreshToken);

        if (!refreshToken) {
            throw new GrokAuthExpiredError(undefined, { hint });
        }

        let rotated: GrokTokens;
        try {
            rotated = await deps.refresh(refreshToken);
        } catch (err) {
            logger.warn({ err, account: account.name }, "grok: the OIDC refresh of the stored grant failed");
            // A refresh that never reached the issuer keeps its cause, so the poll gate can
            // file it as a transport failure instead of an account failure.
            throw new GrokAuthExpiredError(undefined, { cause: err, hint });
        }

        current.credentials.accessToken = await deps.storeSecret(current.id, "accessToken", rotated.accessToken);

        if (rotated.refreshToken !== undefined) {
            current.credentials.refreshToken = await deps.storeSecret(current.id, "refreshToken", rotated.refreshToken);
        }

        current.credentials.expiresAt = rotated.expiresAt;
        logger.info(
            { account: account.name, expiresAt: rotated.expiresAt },
            "grok: refreshed the stored grant via OIDC"
        );

        return rotated.accessToken;
    }, NETWORKED_LOCK_WAIT_MS);
}

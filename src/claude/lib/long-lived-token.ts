import { vaultPathFor } from "@genesiscz/utils/ai/config/migrations/2026-08-secretsToVault";
import type { AiConfigData } from "@genesiscz/utils/ai/config/schema";
import { secrets } from "@genesiscz/utils/security";

/**
 * Attach a long-lived token to an account IN PLACE.
 *
 * Deliberately a mutator over the on-disk data rather than an
 * `editAccount({ credentials: { ...account.credentials, … } })` spread: the
 * browser flow that produces the token takes minutes, and the poll daemon
 * rotates the access/refresh pair during it. Spreading a stale in-memory
 * `credentials` object would write that dead pair back and cost the account its
 * login.
 *
 * Called from inside `AiConfigStore.mutate`, so the vault write below happens
 * under the config lock — the order `AiConfigStore.withLock` documents, config
 * lock first and vault lock second.
 */
export interface ApplyLongLivedTokenInput {
    accountName: string;
    token: string;
    /**
     * Known only when WE minted the token (`login-long --setup-token`). A pasted
     * token's lifetime is unknowable, so passing undefined CLEARS any expiry left
     * behind by a previously minted token instead of mislabelling the new one.
     */
    expiresAt?: number;
    /**
     * The org the identity probe proved the token belongs to, written in the
     * SAME mutation as the token itself (PR #343 review round 11).
     *
     * It used to be a second `updateAccount()` call. A crash or a failed write
     * between the two left the new token live under the old fingerprint, which
     * is precisely the cross-account state this flow exists to prevent — and it
     * would then look verified. One locked mutation, or neither.
     */
    organizationUuid?: string;
}

export async function applyLongLivedToken(data: AiConfigData, input: ApplyLongLivedTokenInput): Promise<void> {
    const entry = data.accounts.find((a) => a.name === input.accountName);

    if (!entry) {
        throw new Error(`Account "${input.accountName}" not found while saving the long-lived token`);
    }

    const vault = await secrets();
    entry.credentials.longLivedToken = await vault.set(vaultPathFor(entry.id, "longLivedToken"), input.token);

    if (input.expiresAt === undefined) {
        delete entry.credentials.longLivedTokenExpiresAt;
    } else {
        entry.credentials.longLivedTokenExpiresAt = input.expiresAt;
    }

    if (input.organizationUuid) {
        entry.organizationUuid = input.organizationUuid;
    }
}

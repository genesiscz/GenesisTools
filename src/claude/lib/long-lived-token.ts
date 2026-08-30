import type { AIConfigData } from "@genesiscz/utils/config/ai.types";

/**
 * Attach a long-lived token to an account IN PLACE.
 *
 * Deliberately a mutator over the on-disk data rather than a
 * `updateAccount({ tokens: { ...account.tokens, … } })` spread: the browser flow
 * that produces the token takes minutes, and the poll daemon rotates the
 * access/refresh pair during it. Spreading a stale in-memory `tokens` object
 * would write that dead pair back and cost the account its login.
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

export function applyLongLivedToken(data: AIConfigData, input: ApplyLongLivedTokenInput): void {
    const entry = data.accounts.find((a) => a.name === input.accountName);

    if (!entry) {
        throw new Error(`Account "${input.accountName}" not found while saving the long-lived token`);
    }

    entry.tokens.longLivedToken = input.token;

    if (input.expiresAt === undefined) {
        delete entry.tokens.longLivedTokenExpiresAt;
    } else {
        entry.tokens.longLivedTokenExpiresAt = input.expiresAt;
    }

    if (input.organizationUuid) {
        entry.organizationUuid = input.organizationUuid;
    }
}

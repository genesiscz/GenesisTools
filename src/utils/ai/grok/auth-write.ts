import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { isAuthEntry, readAuthFileAsync } from "./auth";
import { GROK_OIDC_CLIENT_ID, GROK_OIDC_ISSUER, type GrokTokens, identityFromGrokTokens } from "./oauth";
import { readAuthDocument, writeAuthFileAtomically } from "./refresh";
import type { GrokAuthEntry } from "./types";

/**
 * Whatever the CLI put on the replaced entry, minus the three fields that describe WHOSE
 * token it was.
 *
 * `holdsSameIdentity` (grok/account.ts) accepts `user_id` as proof that an auth file
 * belongs to an account, so an identity inherited from the previous login would vouch for
 * a token that is now somebody else's. The new tokens re-supply all three whenever they
 * name an identity at all; when they cannot, absent beats stale.
 */
function withoutOwner(entry: unknown): Partial<GrokAuthEntry> {
    if (!isAuthEntry(entry)) {
        return {};
    }

    const { email: _email, user_id: _userId, team_id: _teamId, ...rest } = entry;

    return rest;
}

/**
 * Write a login into a Grok CLI auth file the way `grok login` does: one entry keyed
 * `<issuer>::<client id>`, every other entry and non-entry field kept. The fields come
 * from the tokens themselves; the ones the CLI fills from its own API calls (name,
 * avatar, principal) stay absent, and our reader needs only `key`.
 *
 * ⚠️ Verified against our reader and the refresh grant, not yet against the `grok`
 * binary reading a file it did not write itself (issue #377).
 */
export async function writeGrokAuthEntry(authFile: string, tokens: GrokTokens): Promise<void> {
    await mkdir(dirname(authFile), { recursive: true, mode: 0o700 });

    const entries = await readAuthFileAsync(authFile);
    const document: Record<string, unknown> = existsSync(authFile) ? await readAuthDocument(authFile, entries) : {};
    const id = `${GROK_OIDC_ISSUER}::${GROK_OIDC_CLIENT_ID}`;
    const who = identityFromGrokTokens(tokens);
    const entry: GrokAuthEntry = {
        ...withoutOwner(document[id]),
        key: tokens.accessToken,
        ...(tokens.refreshToken === undefined ? {} : { refresh_token: tokens.refreshToken }),
        expires_at: new Date(tokens.expiresAt).toISOString(),
        oidc_client_id: GROK_OIDC_CLIENT_ID,
        oidc_issuer: GROK_OIDC_ISSUER,
        auth_mode: "oidc",
        ...(who.email === undefined ? {} : { email: who.email }),
        ...(who.userId === undefined ? {} : { user_id: who.userId }),
        ...(who.teamId === undefined ? {} : { team_id: who.teamId }),
    };

    document[id] = entry;
    await writeAuthFileAtomically(authFile, document);
}

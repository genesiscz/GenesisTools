import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";
import type { MissingCredential } from "@genesiscz/utils/ai/providers/account-features";
import { grokLoginCommand } from "@genesiscz/utils/genesis-tools/tools/ai";
import { logger } from "@genesiscz/utils/logger";
import { resolveSecret } from "@genesiscz/utils/security";
import {
    decodeJwtClaims,
    entryHoldsSubject,
    getActiveAuthEntry,
    isTokenExpired,
    readAuthFileAsync,
    tokenNamesOtherSubject,
} from "./auth";
import { GrokAuthExpiredError } from "./auth-errors";
import type { StoredGrantSource } from "./client";
import { grokAuthPath } from "./paths";
import { refreshGrokAuthOrThrow } from "./refresh";
import { resolveStoredGrokGrant } from "./stored-grant";
import type { GrokAuthEntry } from "./types";

export interface ResolvedGrokSubToken {
    token: string;
    /**
     * Auth file the token was read from (also usable for reload-on-expiry). Absent for a token
     * held in the vault, so nobody reads or refreshes the Grok CLI's default file for it.
     */
    authPath?: string;
    /**
     * Set for a token held in the vault (a grant `tools grok login` stored, or a pasted token):
     * the way to a fresh token, and the fix when that fails.
     */
    storedGrant?: StoredGrantSource;
    account: { name: string; label?: string };
}

/**
 * Resolve the JWT for a `grok-sub` account in ~/.genesis-tools/ai/config.json.
 *
 * The account is a REFERENCE, not a token copy: `credentials.authFile` (default
 * `~/.grok/auth.json`) points at the Grok CLI's auth file, which the CLI keeps
 * refreshed. A stored `credentials.accessToken` wins when present (for setups
 * without the CLI), but goes stale on its own — the file reference is the
 * recommended mode.
 */
export interface ResolveGrokSubTokenOptions {
    /**
     * Diagnosis mode: read the stored JWT, never perform the OIDC grant.
     *
     * `refreshGrokAuth` rewrites `~/.grok/auth.json` and rotates the CLI's
     * `refresh_token`, so a probe that refreshed would spend a grant the Grok
     * CLI owns and rewrite a file it manages.
     */
    noRefresh?: boolean;
    /**
     * Resolve straight from THIS auth file instead of looking the account up by
     * name. The plugin already holds `credentials.authFile` from its bind
     * context, and re-querying the legacy config for it meant a binding was not
     * actually determined by the context it was given.
     */
    authFile?: string;
}

/**
 * The one wording for "this account holds nothing to poll or bind". The usage plugin's
 * `missingCredential` preflight returns the same object, so the poll round and this
 * resolver refuse the same account for the same reason and name the same fix.
 */
export function grokCredentialRefusal(accountName: string): MissingCredential {
    return {
        message: `Account "${accountName}" holds no grok credential (no authFile, no accessToken).`,
        remedy: grokLoginCommand(accountName),
    };
}

/** The live token in a Grok CLI auth file, refreshed via OIDC when expired. */
async function tokenFromAuthFile(authPath: string, noRefresh?: boolean): Promise<string> {
    const entries = await readAuthFileAsync(authPath);
    const active = getActiveAuthEntry(entries);

    if (!active) {
        throw new GrokAuthExpiredError(authPath);
    }

    return ensureFreshToken(active.key, authPath, { noRefresh });
}

export async function resolveGrokSubToken(
    accountName?: string,
    options?: ResolveGrokSubTokenOptions
): Promise<ResolvedGrokSubToken> {
    if (options?.authFile) {
        return {
            token: await tokenFromAuthFile(options.authFile, options.noRefresh),
            authPath: options.authFile,
            account: { name: accountName ?? "grok-sub" },
        };
    }

    const store = await AiConfigStore.load();
    let account: AccountEntry | undefined;

    if (accountName) {
        account = store.account(accountName);

        if (!account) {
            throw new Error(`Account "${accountName}" not found in AI config`);
        }

        if (account.provider !== "grok-sub") {
            throw new Error(`Account "${accountName}" is "${account.provider}", expected "grok-sub"`);
        }
    } else {
        account = store.accounts({ provider: "grok-sub" })[0];

        if (!account) {
            throw new Error('No "grok-sub" account configured in ~/.genesis-tools/ai/config.json');
        }
    }

    // A named account that holds NEITHER reference NOR token is an error, not a
    // licence to read whoever the Grok CLI is logged in as: after `logout` the
    // entry survives without its file, and falling back to the default home
    // would silently serve (and refresh) another user's credential (PR #360
    // review t1).
    const credentials = account.credentials;

    if (!credentials.authFile && !credentials.accessToken) {
        const refusal = grokCredentialRefusal(account.name);
        throw new Error(`${refusal.message} Run: ${refusal.remedy}`);
    }

    // A grant our own `tools grok login` stored in the vault. It carries its own refresh
    // token, so expiry is answered by the OIDC refresh grant against THAT grant, and the
    // Grok CLI's file is never read for it: nothing in that file is this account's.
    //
    // `expiresAt` is what tells this shape apart from a pasted JWT, and it has to be: a
    // pasted JWT is vaulted too, so a `SecureRef` test cannot tell the two apart.
    // Only a grant we performed writes an expiry beside the token, and `clearCredentials`
    // removes the two together. Keying on `refreshToken` alone would send a grant the
    // issuer returned WITHOUT one to the Grok CLI's default file, which is exactly the
    // cross-account read this branch exists to prevent.
    if (!credentials.authFile && (credentials.expiresAt !== undefined || credentials.refreshToken)) {
        const name = account.name;

        return {
            token: await resolveStoredGrokGrant(name, {
                ...(options?.noRefresh === undefined ? {} : { noRefresh: options.noRefresh }),
            }),
            storedGrant: {
                refresh: (_reason, force) =>
                    resolveStoredGrokGrant(name, {
                        force,
                        ...(options?.noRefresh === undefined ? {} : { noRefresh: options.noRefresh }),
                    }),
                hint: `Run: ${grokLoginCommand(name)}`,
            },
            account: pick(account),
        };
    }

    const authPath = credentials.authFile ?? grokAuthPath();

    // An explicit `authFile` reference wins over stored tokens (which can go
    // stale on their own — the referenced file is CLI-refreshed).
    // Resolved here, where it is spent: only the stored-token branch reads the vault.
    const storedToken = credentials.authFile ? undefined : await resolveSecret(credentials.accessToken);

    // A vault pointer whose entry is gone resolves to nothing. That is no credential, the
    // same as an account without one: falling through to the default file below would serve,
    // and refresh, whoever the Grok CLI is logged in as.
    if (!credentials.authFile && !storedToken) {
        const refusal = grokCredentialRefusal(account.name);
        throw new Error(`${refusal.message} Run: ${refusal.remedy}`);
    }

    if (storedToken) {
        // A stored token carries no refresh metadata of its own, and `authPath`
        // here is only the CLI's default file — whoever the CLI happens to be
        // logged in as. Refreshing from it BLIND would hand back a DIFFERENT
        // account's token and quietly cross a billing boundary. So the default
        // file is used only when it PROVES it carries the same identity as the
        // copy that expired; without that proof, expiry stays fatal.
        if (isTokenExpired(decodeJwtClaims(storedToken))) {
            const subject = decodeJwtClaims(storedToken)?.sub;
            const entry = await sameIdentityEntry(subject, authPath);

            if (subject && entry) {
                logger.info(
                    { account: account.name, authPath },
                    "grok: stored accessToken expired; the default auth file proves the same identity, resolving from it"
                );

                return {
                    token: await sameIdentityToken({ entry, subject, authPath, noRefresh: options?.noRefresh }),
                    authPath,
                    account: pick(account),
                };
            }

            logger.warn(
                { account: account.name, authPath },
                "grok: stored accessToken expired and no auth file proves it belongs to this account"
            );

            throw new GrokAuthExpiredError(authPath);
        }

        // No `authPath`: the default file is not this token's source. The way to a new token
        // after an upstream 401 is the recovery, which asks the same identity proof first.
        return {
            token: storedToken,
            storedGrant: pastedTokenRecovery({
                accountName: account.name,
                storedToken,
                authPath,
                ...(options?.noRefresh === undefined ? {} : { noRefresh: options.noRefresh }),
            }),
            account: pick(account),
        };
    }

    return { token: await tokenFromAuthFile(authPath, options?.noRefresh), authPath, account: pick(account) };
}

/**
 * The active entry of `authPath` when it holds the SAME paying identity as the stored copy.
 *
 * The `sub` claim of a Grok JWT is the xAI user id, and it survives expiry —
 * decoding does not check `exp`. So an expired copy still names who it belonged
 * to, and an auth file whose active entry names the same user is that account's
 * own live credential, not a sibling's. That is the whole billing-boundary
 * question, answered from data rather than from the file's location.
 *
 * The entry's own `user_id` counts as proof too: it is the same xAI user id, and
 * it still identifies the file when the active token itself will not decode.
 *
 * The entry itself is returned, so the token handed out is the one this read proved,
 * never a second read of a file the Grok CLI may have switched to another account.
 */
async function sameIdentityEntry(subject: string | undefined, authPath: string): Promise<GrokAuthEntry | null> {
    if (!subject) {
        return null;
    }

    const active = getActiveAuthEntry(await readAuthFileAsync(authPath));

    return active && entryHoldsSubject(active, subject) ? active : null;
}

/**
 * The usable token of an entry that proved `subject`. An expired one is refreshed under the
 * same proof (checked again inside the refresh lock, right before the grant is spent), and a
 * result that names another user is refused rather than sent on this account's behalf.
 */
async function sameIdentityToken(options: {
    entry: GrokAuthEntry;
    subject: string;
    authPath: string;
    noRefresh?: boolean;
}): Promise<string> {
    const { entry, subject, authPath, noRefresh } = options;
    const token = await ensureFreshToken(entry.key, authPath, { noRefresh, subject });

    return requireSubject(token, subject, authPath);
}

function requireSubject(token: string, subject: string, authPath: string): string {
    if (tokenNamesOtherSubject(token, subject)) {
        logger.warn({ authPath }, "grok: the token the auth file yielded belongs to another identity, refusing it");
        throw new GrokAuthExpiredError(authPath);
    }

    return token;
}

/**
 * The way to a new token for a pasted `accessToken`, after the upstream refused it or it
 * expired in a long-lived client.
 *
 * A pasted token carries no grant of its own, and the default auth file holds whoever the
 * Grok CLI is logged in as. So the file is read, and its grant spent, only when it proves
 * the same identity as the pasted copy (the rule of the expiry branch above). Without that
 * proof the refusal is final and names the login that gives the account a grant of its own.
 */
function pastedTokenRecovery(options: {
    accountName: string;
    storedToken: string;
    authPath: string;
    noRefresh?: boolean;
}): StoredGrantSource {
    const { accountName, storedToken, authPath, noRefresh } = options;
    const hint = `Run: ${grokLoginCommand(accountName)}`;
    const subject = decodeJwtClaims(storedToken)?.sub;
    // The token this recovery last handed out. The client holds it, so a later forced call
    // means the upstream refused THIS one, not the pasted copy the recovery started from.
    let current = storedToken;

    return {
        hint,
        refresh: async (reason, force) => {
            const entry = await sameIdentityEntry(subject, authPath);

            if (!subject || !entry) {
                logger.warn(
                    { account: accountName, authPath, reason },
                    "grok: the stored accessToken needs a new token and no auth file proves it belongs to this account"
                );

                throw new GrokAuthExpiredError(undefined, { hint });
            }

            // A newer token of the same identity is used as is. Only when the file still
            // holds the very token the upstream refused does a forced grant help.
            if (!force || entry.key !== current) {
                current = await sameIdentityToken({ entry, subject, authPath, noRefresh });
                return current;
            }

            // Guard above the consuming call: the grant rotates the Grok CLI's refresh token.
            if (noRefresh) {
                throw new Error(
                    `Refusing to refresh the Grok token in ${authPath} during a diagnosis (${reason}). ${hint}`
                );
            }

            const refreshed = await refreshGrokAuthOrThrow({
                authPath,
                force: true,
                expectedSubject: subject,
                context: { account: accountName, reason },
                onSuccess: "grok: refreshed the default auth file, which proves the stored token's identity",
                onFailure: "grok: OIDC refresh of the identity-matched default auth file did not yield a usable token",
            });

            current = requireSubject(refreshed, subject, authPath);
            return current;
        },
    };
}

/**
 * An expired token is recoverable on its own: the auth file carries the OIDC
 * `refresh_token` / issuer / client id, so perform the grant rather than telling
 * the caller to run the `grok` CLI by hand — impossible for a background daemon,
 * and the reason provider detection used to fail outright. Only a refresh that
 * cannot be attempted (no refresh fields) or that the issuer rejects is fatal.
 */
async function ensureFreshToken(
    token: string,
    authPath: string,
    options: { noRefresh?: boolean; subject?: string }
): Promise<string> {
    const { noRefresh, subject } = options;

    if (!isTokenExpired(decodeJwtClaims(token))) {
        return token;
    }

    // Guard above the consuming call: refreshGrokAuth rewrites auth.json and
    // rotates the refresh token, which a diagnosis must never do.
    if (noRefresh) {
        throw new Error(
            `The grok-sub token in ${authPath} is expired and the OIDC refresh is disabled for diagnosis ` +
                "(it would rotate the Grok CLI's refresh token and rewrite its auth file). Run: grok"
        );
    }

    return refreshGrokAuthOrThrow({
        authPath,
        ...(subject === undefined ? {} : { expectedSubject: subject }),
        context: {},
        onSuccess: "grok: refreshed the expired grok-sub token via OIDC",
        onFailure: "grok: OIDC refresh did not yield a usable token for the grok-sub account",
    });
}

function pick(account: AccountEntry): { name: string; label?: string } {
    return { name: account.name, label: account.label };
}

import { AIConfig } from "@genesiscz/utils/ai/AIConfig";
import type { AIAccountEntry } from "@genesiscz/utils/config/ai.types";
import { logger } from "@genesiscz/utils/logger";
import { decodeJwtClaims, getActiveAuthEntry, isTokenExpired, readAuthFileAsync } from "./auth";
import { GrokAuthExpiredError } from "./auth-errors";
import { grokAuthPath } from "./paths";
import { refreshGrokAuth } from "./refresh";

export interface ResolvedGrokSubToken {
    token: string;
    /** Auth file the token was read from (also usable for reload-on-expiry). */
    authPath: string;
    account: { name: string; label?: string };
}

/**
 * Resolve the JWT for a `grok-sub` account in ~/.genesis-tools/ai/config.json.
 *
 * The account is a REFERENCE, not a token copy: `tokens.authFile` (default
 * `~/.grok/auth.json`) points at the Grok CLI's auth file, which the CLI keeps
 * refreshed. A stored `tokens.accessToken` wins when present (for setups
 * without the CLI), but goes stale on its own — the file reference is the
 * recommended mode.
 */
export async function resolveGrokSubToken(accountName?: string): Promise<ResolvedGrokSubToken> {
    const config = await AIConfig.load();
    let account: AIAccountEntry | undefined;

    if (accountName) {
        account = config.getAccount(accountName);

        if (!account) {
            throw new Error(`Account "${accountName}" not found in AI config`);
        }

        if (account.provider !== "grok-sub") {
            throw new Error(`Account "${accountName}" is "${account.provider}", expected "grok-sub"`);
        }
    } else {
        account = config.getAccountsByProvider("grok-sub")[0];

        if (!account) {
            throw new Error('No "grok-sub" account configured in ~/.genesis-tools/ai/config.json');
        }
    }

    const authPath = account.tokens.authFile ?? grokAuthPath();

    // An explicit `authFile` reference wins over stored tokens (which can go
    // stale on their own — the referenced file is CLI-refreshed).
    if (account.tokens.accessToken && !account.tokens.authFile) {
        // A stored token carries no refresh metadata of its own, and `authPath`
        // here is only the CLI's default file — whoever the CLI happens to be
        // logged in as. Refreshing from it would hand back a DIFFERENT account's
        // token and quietly cross a billing boundary, so expiry is fatal instead.
        if (isTokenExpired(decodeJwtClaims(account.tokens.accessToken))) {
            logger.warn(
                { account: account.name },
                "grok: stored accessToken expired and the account references no authFile to refresh from"
            );

            throw new GrokAuthExpiredError(authPath);
        }

        return { token: account.tokens.accessToken, authPath, account: pick(account) };
    }

    const entries = await readAuthFileAsync(authPath);
    const active = getActiveAuthEntry(entries);

    if (!active) {
        throw new GrokAuthExpiredError(authPath);
    }

    const token = await ensureFreshToken(active.key, authPath);
    return { token, authPath, account: pick(account) };
}

/**
 * An expired token is recoverable on its own: the auth file carries the OIDC
 * `refresh_token` / issuer / client id, so perform the grant rather than telling
 * the caller to run the `grok` CLI by hand — impossible for a background daemon,
 * and the reason provider detection used to fail outright. Only a refresh that
 * cannot be attempted (no refresh fields) or that the issuer rejects is fatal.
 */
async function ensureFreshToken(token: string, authPath: string): Promise<string> {
    if (!isTokenExpired(decodeJwtClaims(token))) {
        return token;
    }

    const refreshed = await refreshGrokAuth({ path: authPath });

    if (!refreshed || isTokenExpired(decodeJwtClaims(refreshed))) {
        logger.warn({ authPath }, "grok: OIDC refresh did not yield a usable token for the grok-sub account");
        throw new GrokAuthExpiredError(authPath);
    }

    logger.info({ authPath }, "grok: refreshed the expired grok-sub token via OIDC");

    return refreshed;
}

function pick(account: AIAccountEntry): { name: string; label?: string } {
    return { name: account.name, label: account.label };
}

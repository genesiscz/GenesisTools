import { AIConfig } from "@app/utils/ai/AIConfig";
import type { AIAccountEntry } from "@app/utils/config/ai.types";
import { decodeJwtClaims, getActiveAuthEntry, isTokenExpired, readAuthFileAsync } from "./auth";
import { GrokAuthExpiredError } from "./auth-errors";
import { grokAuthPath } from "./paths";

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
        assertNotExpired(account.tokens.accessToken, authPath);
        return { token: account.tokens.accessToken, authPath, account: pick(account) };
    }

    const entries = await readAuthFileAsync(authPath);
    const active = getActiveAuthEntry(entries);

    if (!active) {
        throw new GrokAuthExpiredError(authPath);
    }

    assertNotExpired(active.key, authPath);
    return { token: active.key, authPath, account: pick(account) };
}

function assertNotExpired(token: string, authPath: string): void {
    if (isTokenExpired(decodeJwtClaims(token))) {
        throw new GrokAuthExpiredError(authPath);
    }
}

function pick(account: AIAccountEntry): { name: string; label?: string } {
    return { name: account.name, label: account.label };
}

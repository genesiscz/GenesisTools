import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { codexHomesIn } from "@genesiscz/utils/providers/session-paths";
import { AiConfigStore } from "../../../config/AiConfigStore";
import type { AccountEntry } from "../../../config/schema";
import { extractAccountId, extractEmail, extractPlanType, readCodexAuthJson } from "../../../openai/codex-auth";
import type { AccountIdentity, DiscoveredHome } from "../../account-features";

/**
 * Codex keeps one profile per home directory: `~/.codex` plus any `~/.codex-*`
 * sibling. Every identity here is decoded from the JWT claims already on disk —
 * no network, because discovery is a diagnostic and must not spend a grant.
 */
export interface DiscoverCodexOptions {
    /** Directory the profile homes sit in. Injected by tests; defaults to `$HOME`. */
    root?: string;
    /** Accounts to match homes against. Read from the store when omitted. */
    accounts?: AccountEntry[];
}

/**
 * The account already pointing into this home, matched on `authFile` or `dataDir`.
 *
 * The prefix is built with `sep`, not a literal `/`: `resolve()` returns
 * backslashes on Windows, so a hard-coded slash matched nothing there and every
 * bound Codex home was reported as unbound (PR #360 review t15).
 */
function boundAccountId(home: string, accounts: AccountEntry[]): string | undefined {
    const prefix = `${resolve(home)}${sep}`;

    return accounts.find((account) => {
        const authFile = account.credentials.authFile;
        const dataDir = account.credentials.dataDir;

        return (
            (authFile !== undefined && resolve(authFile).startsWith(prefix)) ||
            (dataDir !== undefined && resolve(dataDir) === resolve(home))
        );
    })?.id;
}

export async function discoverCodexHomes(options: DiscoverCodexOptions = {}): Promise<DiscoveredHome[]> {
    const root = options.root ?? homedir();
    const accounts = options.accounts ?? (await AiConfigStore.readOnly()).accounts({ provider: "openai-sub" });
    const found: DiscoveredHome[] = [];

    for (const home of codexHomesIn(root)) {
        const authFile = join(home, "auth.json");
        const tokens = existsSync(authFile) ? await readCodexAuthJson(authFile) : null;

        let identity: AccountIdentity | undefined;

        if (tokens) {
            const claims = tokens.idToken ?? tokens.accessToken;
            identity = {
                email: extractEmail(claims),
                accountUuid: tokens.accountId ?? extractAccountId(claims),
                plan: extractPlanType(claims),
            };
        }

        found.push({
            home,
            ...(tokens ? { authFile } : {}),
            ...(identity ? { identity } : {}),
            ...(boundAccountId(home, accounts) ? { boundToAccountId: boundAccountId(home, accounts) } : {}),
        });
    }

    logger.debug({ root, homes: found.length }, "codex: discovered profile homes");
    return found;
}

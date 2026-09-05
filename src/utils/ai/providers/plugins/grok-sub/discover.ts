import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { grokRoot } from "@genesiscz/utils/grok/worker-paths";
import { logger } from "@genesiscz/utils/logger";
import { AiConfigStore } from "../../../config/AiConfigStore";
import type { AccountEntry } from "../../../config/schema";
import { decodeJwtClaims, getActiveAuthEntry, readAuthFileAsync } from "../../../grok/auth";
import { grokAuthPath, resolveGrokHome } from "../../../grok/paths";
import type { AccountIdentity, DiscoveredHome } from "../../account-features";

/**
 * Grok homes: the active `$GROK_HOME` (default `~/.grok`), every `~/.grok-*`
 * sibling, and every harness worker home under `~/.genesis-tools/grok/`.
 *
 * The worker homes hold no `auth.json` of their own — the harness authenticates
 * them with `GROK_AUTH_PATH` pointing at the default login — so they are
 * reported as belonging to whichever account owns that file. Their transcripts
 * are real spend, which is why they must appear at all.
 */
export interface DiscoverGrokOptions {
    /** Directory the `~/.grok*` homes sit in. Injected by tests; defaults to `$HOME`. */
    root?: string;
    /** The active grok home. Defaults to `$GROK_HOME` or `<root>/.grok`. */
    home?: string;
    /** Where worker homes live. Defaults to `~/.genesis-tools/grok`. */
    workerRoot?: string;
    accounts?: AccountEntry[];
}

function grokHomesIn(root: string): string[] {
    if (!existsSync(root)) {
        return [];
    }

    const homes: string[] = [];

    for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name.startsWith(".grok-")) {
            homes.push(join(root, entry.name));
        }
    }

    return homes.sort();
}

function workerHomesIn(workerRoot: string): string[] {
    if (!existsSync(workerRoot)) {
        return [];
    }

    return readdirSync(workerRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith("worker-home"))
        .map((entry) => join(workerRoot, entry.name))
        .sort();
}

async function identityFromAuthFile(authFile: string): Promise<AccountIdentity | undefined> {
    const active = getActiveAuthEntry(await readAuthFileAsync(authFile));

    if (!active) {
        return undefined;
    }

    const claims = decodeJwtClaims(active.key);

    if (!claims) {
        return undefined;
    }

    return {
        accountUuid: claims.sub,
        ...(claims.tier === undefined ? {} : { plan: `tier ${claims.tier}` }),
    };
}

function accountForAuthFile(authFile: string, accounts: AccountEntry[]): string | undefined {
    return accounts.find(
        (account) =>
            account.credentials.authFile !== undefined && resolve(account.credentials.authFile) === resolve(authFile)
    )?.id;
}

export async function discoverGrokHomes(options: DiscoverGrokOptions = {}): Promise<DiscoveredHome[]> {
    const root = options.root ?? homedir();
    const defaultHome = options.home ?? (options.root ? join(options.root, ".grok") : resolveGrokHome());
    const workerRoot = options.workerRoot ?? grokRoot();
    const accounts = options.accounts ?? (await AiConfigStore.load()).accounts({ provider: "grok-sub" });
    const found: DiscoveredHome[] = [];

    for (const home of [defaultHome, ...grokHomesIn(root).filter((dir) => resolve(dir) !== resolve(defaultHome))]) {
        const authFile = join(home, "auth.json");

        if (!existsSync(authFile)) {
            continue;
        }

        const identity = await identityFromAuthFile(authFile);

        found.push({
            home,
            authFile,
            ...(identity ? { identity } : {}),
            ...(accountForAuthFile(authFile, accounts)
                ? { boundToAccountId: accountForAuthFile(authFile, accounts) }
                : {}),
        });
    }

    // A worker home is a session tree, not a login: it is bound to whichever
    // account owns the default auth file, because that is the credential
    // `GROK_AUTH_PATH` hands the worker.
    const defaultAuthFile = options.root ? join(defaultHome, "auth.json") : grokAuthPath(defaultHome);
    const workerOwner = accountForAuthFile(defaultAuthFile, accounts);

    for (const home of workerHomesIn(workerRoot)) {
        found.push({
            home,
            ...(workerOwner ? { boundToAccountId: workerOwner } : {}),
        });
    }

    logger.debug(
        {
            root,
            workerRoot,
            homes: found.length,
            workerHomes: found.filter((h) => basename(dirname(h.home)) === "grok").length,
        },
        "grok: discovered homes"
    );

    return found;
}

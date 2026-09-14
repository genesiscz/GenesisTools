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

/** Every `worker-home*` directory under the harness root. Also the spend scope's glob. */
export function workerHomesIn(workerRoot: string): string[] {
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

function accountForAuthFile(authFile: string, accounts: AccountEntry[]): AccountEntry | undefined {
    return accounts.find(
        (account) =>
            account.credentials.authFile !== undefined && resolve(account.credentials.authFile) === resolve(authFile)
    );
}

/**
 * One config read, answering the account NAME whose login file any grok home holds.
 *
 * `grokAccountNameForHome` used to read and zod-parse `~/.genesis-tools/ai/config.json` on
 * EVERY call — `readOnly()` has no cache the way `load()`'s process singleton does. A session
 * listing calls it once per grok row (thousands, all resolving the same handful of homes), so
 * the read has to happen once for the whole listing, not once per row.
 */
export async function grokAccountNameLookup(): Promise<(home: string) => string | undefined> {
    // `readOnly()`, never `load()`: this is a metadata lookup reached from session LISTING, and
    // `load()` may run config migrations. An inspection path must not write durable state.
    const accounts = (await AiConfigStore.readOnly()).accounts({ provider: "grok-sub" });

    return (home: string) => accountForAuthFile(join(home, "auth.json"), accounts)?.name;
}

/**
 * The account NAME whose login file a grok home holds, for `TOOLS_GROK_ACCOUNT`.
 *
 * The launcher exports that variable so a live grok process can be attributed to an account
 * off the process table, the same way `tools claude run` and `tools codex run` do. Grok itself
 * identifies a login by its home, never by a name, so this is the translation.
 *
 * A single-home convenience over {@link grokAccountNameLookup} — reach for the lookup directly
 * when resolving more than one home, so the config is read once.
 */
export async function grokAccountNameForHome(home: string): Promise<string | undefined> {
    return (await grokAccountNameLookup())(home);
}

export async function discoverGrokHomes(options: DiscoverGrokOptions = {}): Promise<DiscoveredHome[]> {
    const root = options.root ?? homedir();
    const defaultHome = options.home ?? (options.root ? join(options.root, ".grok") : resolveGrokHome());
    const workerRoot = options.workerRoot ?? grokRoot();
    // `readOnly()`, never `load()`: `discoverGrokHomes` is reached only from inspection surfaces
    // (`account show`, `account discover`, the spend reports), and `load()` may run a config
    // migration that a read-only path must not trigger.
    const accounts = options.accounts ?? (await AiConfigStore.readOnly()).accounts({ provider: "grok-sub" });
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
            ...(accountForAuthFile(authFile, accounts)?.id
                ? { boundToAccountId: accountForAuthFile(authFile, accounts)?.id }
                : {}),
        });
    }

    // A worker home is a session tree, not a login: it is bound to whichever
    // account owns the default auth file, because that is the credential
    // `GROK_AUTH_PATH` hands the worker.
    const defaultAuthFile = options.root ? join(defaultHome, "auth.json") : grokAuthPath(defaultHome);
    const workerOwner = accountForAuthFile(defaultAuthFile, accounts)?.id;

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

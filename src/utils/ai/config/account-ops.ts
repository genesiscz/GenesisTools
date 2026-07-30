import { logger } from "@genesiscz/utils/logger";
import { secrets } from "@genesiscz/utils/security";
import { describeCredential } from "../providers/credentials";
import type { ProviderBinding } from "../providers/plugin-types";
import { providerPlugin, tryProviderPlugin } from "../providers/registry";
import { AiConfigStore } from "./AiConfigStore";
import { slugifyAccountId } from "./migrations/2026-08-configV4";
import { vaultPathFor } from "./migrations/2026-08-secretsToVault";
import type { Referrer } from "./refs";
import { referrersOf } from "./refs";
import type { AccountBilling, AccountEntry, AiConfigData, UseEnvApiKey } from "./schema";

/**
 * Account CRUD as one library, so the CLI, the TUI and any future surface share
 * a single set of rules: secrets go to the vault and never to the config file,
 * ids are minted once and never rewritten, and a delete that would break a live
 * reference has to be forced.
 *
 * Every write takes the config lock first and the vault lock inside it, which is
 * the order `AiConfigStore.withLock` documents; reversing it deadlocks two
 * processes rotating a token at the same time.
 */

/** Credential fields whose values are secrets and therefore vault-bound. */
export const SECRET_CREDENTIAL_FIELDS = ["apiKey", "accessToken", "refreshToken"] as const;
export type SecretCredentialField = (typeof SECRET_CREDENTIAL_FIELDS)[number];

export interface AddAccountInput {
    provider: string;
    name: string;
    billing?: AccountBilling["mode"];
    label?: string;
    tags?: string[];
    /** Base URL for gateway / self-hosted providers; `credential.fields` cannot express it. */
    endpoint?: string;
    /** Secret values, written to the vault. The config only ever gets the ref back. */
    secrets?: Partial<Record<SecretCredentialField, string>>;
    /** Filesystem references (a CLI's auth file, a data dir). Paths, not secrets. */
    authFile?: string;
    dataDir?: string;
    useEnvApiKey?: UseEnvApiKey;
    enabled?: boolean;
}

export interface EditAccountPatch {
    enabled?: boolean;
    label?: string;
    tags?: string[];
    rename?: string;
    endpoint?: string;
    useEnvApiKey?: UseEnvApiKey;
}

export class AccountNotFoundError extends Error {
    constructor(idOrName: string) {
        super(`No AI account matches "${idOrName}". List them with: tools ai config account list`);
        this.name = "AccountNotFoundError";
    }
}

export class AccountInUseError extends Error {
    constructor(
        readonly account: AccountEntry,
        readonly referrers: Referrer[]
    ) {
        super(
            `Account "${account.name}" is referenced by ${referrers.length} place(s): ${referrers
                .map((referrer) => referrer.path)
                .join(", ")}. Re-run with --force to remove it anyway.`
        );
        this.name = "AccountInUseError";
    }
}

function requireAccount(config: AiConfigData, idOrName: string): AccountEntry {
    const byId = config.accounts.find((entry) => entry.id === idOrName);
    if (byId) {
        return byId;
    }

    const byName = config.accounts.filter((entry) => entry.name === idOrName);
    if (byName.length > 1) {
        throw new Error(
            `Account name "${idOrName}" is ambiguous (${byName.length} accounts share it). Use the id: ${byName
                .map((entry) => entry.id)
                .join(", ")}.`
        );
    }

    if (!byName[0]) {
        throw new AccountNotFoundError(idOrName);
    }

    return byName[0];
}

/** Subscription providers bill a flat plan; everything else meters per token. */
function defaultBilling(provider: string): AccountBilling["mode"] {
    const plugin = tryProviderPlugin(provider);

    if (!plugin) {
        return "metered";
    }

    if (plugin.kind === "subscription") {
        return "subscription";
    }

    return plugin.kind === "local" ? "free" : "metered";
}

export async function addAccount(input: AddAccountInput): Promise<AccountEntry> {
    // Fail before any write when the provider is unknown, so a typo cannot leave
    // an account nothing can ever bind.
    providerPlugin(input.provider);

    const store = await AiConfigStore.load();

    return store.withLock(async (config) => {
        if (config.accounts.some((entry) => entry.name === input.name)) {
            throw new Error(`An account named "${input.name}" already exists. Pick another name or edit that one.`);
        }

        const id = slugifyAccountId(input.name, new Set(config.accounts.map((entry) => entry.id)));
        const account: AccountEntry = {
            id,
            name: input.name,
            provider: input.provider,
            enabled: input.enabled ?? true,
            billing: { mode: input.billing ?? defaultBilling(input.provider) },
            credentials: {},
            useEnvApiKey: input.useEnvApiKey ?? false,
            ...(input.label ? { label: input.label } : {}),
            ...(input.tags?.length ? { tags: input.tags } : {}),
            ...(input.endpoint ? { endpoint: input.endpoint } : {}),
        };

        if (input.authFile) {
            account.credentials.authFile = input.authFile;
        }

        if (input.dataDir) {
            account.credentials.dataDir = input.dataDir;
        }

        const vault = await secrets();
        for (const field of SECRET_CREDENTIAL_FIELDS) {
            const value = input.secrets?.[field];
            if (!value) {
                continue;
            }

            account.credentials[field] = await vault.set(vaultPathFor(id, field), value);
        }

        config.accounts.push(account);
        logger.info({ id, provider: input.provider }, "added AI account");
        return account;
    });
}

export async function editAccount(idOrName: string, patch: EditAccountPatch): Promise<AccountEntry> {
    const store = await AiConfigStore.load();

    return store.withLock(async (config) => {
        const account = requireAccount(config, idOrName);

        if (patch.rename !== undefined && patch.rename !== account.name) {
            if (config.accounts.some((entry) => entry.name === patch.rename)) {
                throw new Error(`An account named "${patch.rename}" already exists.`);
            }

            // Refs are built from the immutable id, so nothing else needs rewriting.
            account.name = patch.rename;
        }

        if (patch.enabled !== undefined) {
            account.enabled = patch.enabled;
        }

        if (patch.label !== undefined) {
            account.label = patch.label;
        }

        if (patch.tags !== undefined) {
            account.tags = patch.tags.length > 0 ? patch.tags : undefined;
        }

        if (patch.endpoint !== undefined) {
            account.endpoint = patch.endpoint.length > 0 ? patch.endpoint : undefined;
        }

        if (patch.useEnvApiKey !== undefined) {
            account.useEnvApiKey = patch.useEnvApiKey;
        }

        logger.info({ id: account.id }, "edited AI account");
        return account;
    });
}

export interface RemoveAccountResult {
    account: AccountEntry;
    referrers: Referrer[];
    /** Vault entries deleted along with the account, so no orphan is left behind. */
    secretsDeleted: string[];
}

/**
 * Delete an account, refusing while anything still points at it.
 *
 * Its vault entries go with it: leaving them behind would be an unreadable
 * orphan that `doctor` flags forever and that nothing can ever use again,
 * because the id it is keyed by is gone.
 */
export async function removeAccount(idOrName: string, options: { force?: boolean } = {}): Promise<RemoveAccountResult> {
    const store = await AiConfigStore.load();

    return store.withLock(async (config) => {
        const account = requireAccount(config, idOrName);
        const referrers = await referrersOf(config, account.id);

        if (referrers.length > 0 && !options.force) {
            throw new AccountInUseError(account, referrers);
        }

        const vault = await secrets();
        const owned = await vault.list(vaultPathFor(account.id, ""));
        const secretsDeleted: string[] = [];

        for (const path of owned) {
            if (await vault.delete(path)) {
                secretsDeleted.push(path);
            }
        }

        config.accounts = config.accounts.filter((entry) => entry.id !== account.id);
        logger.info({ id: account.id, referrers: referrers.length, secretsDeleted }, "removed AI account");
        return { account, referrers, secretsDeleted };
    });
}

export interface AccountTestResult {
    account: AccountEntry;
    credential: { ok: boolean; detail: string };
    /** Undefined when the plugin declares no health probe. */
    health?: { ok: boolean; detail: string };
    /** Whether the provider could actually be bound with the resolved credential. */
    binding: { ok: boolean; detail: string };
    ok: boolean;
}

/**
 * Prove an account works: resolve its credential, run the plugin's health probe,
 * and bind the provider once. Binding is the cheap end-to-end call — it is what
 * every task facade does before its first token, and it needs no network.
 *
 * Every plugin call here carries `probe: true`. Testing an account must observe
 * it, never change it: a subscription bind that refreshed would spend the
 * single-use grant that `test` was supposed to be reporting on.
 */
export async function testAccount(idOrName: string, options: { live?: boolean } = {}): Promise<AccountTestResult> {
    const store = await AiConfigStore.load();
    const account = requireAccount(store.data(), idOrName);
    const plugin = providerPlugin(account.provider);

    const described = await describeCredential(account, plugin.credential);
    const credential = { ok: described.ok, detail: described.detail };

    let health: AccountTestResult["health"];
    if (options.live && plugin.health) {
        try {
            health = await plugin.health({ account, probe: true });
        } catch (err) {
            logger.debug({ err, account: account.name }, "health probe threw during account test");
            health = { ok: false, detail: err instanceof Error ? err.message : String(err) };
        }
    }

    let binding: AccountTestResult["binding"];
    let bound: ProviderBinding | undefined;

    try {
        bound = await plugin.bind({ account, probe: true });
        binding = { ok: true, detail: `bound ${plugin.id} (${bound.billed ? "billed" : "not billed"})` };
    } catch (err) {
        logger.debug({ err, account: account.name }, "bind failed during account test");
        binding = { ok: false, detail: err instanceof Error ? err.message : String(err) };
    } finally {
        bound?.dispose?.();
    }

    return {
        account,
        credential,
        health,
        binding,
        ok: credential.ok && binding.ok && health?.ok !== false,
    };
}

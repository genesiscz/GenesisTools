import { logger } from "@genesiscz/utils/logger";
import { secrets } from "@genesiscz/utils/security";
import type { LoginOutcome } from "../providers/account-features";
import { describeCredential } from "../providers/credentials";
import type { ProviderBinding } from "../providers/plugin-types";
import { providerPlugin, tryProviderPlugin } from "../providers/registry";
import { AiConfigStore } from "./AiConfigStore";
import { slugifyAccountId } from "./migrations/2026-08-configV4";
import { vaultPathFor } from "./migrations/2026-08-secretsToVault";
import type { Referrer } from "./refs";
import { accountRef, referrersOf } from "./refs";
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
    /**
     * Both were settable at `account add` time and nowhere else, so an account
     * whose auth file moved could not be repaired through the CLI at all, and the
     * repair hint for a missing one had no command to name.
     */
    authFile?: string;
    dataDir?: string;
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

/**
 * Every vault entry this account owns, deleted.
 *
 * Keyed by the immutable account id, so a prefix list catches fields no constant
 * in this file names — the dotted `secondary.*` paths, and anything a future
 * credential adds. Used both when the account goes away and when a provider
 * switch makes its old secrets unreachable.
 */
async function deleteAccountSecrets(accountId: string): Promise<string[]> {
    const vault = await secrets();
    const owned = await vault.list(vaultPathFor(accountId, ""));
    const deleted: string[] = [];

    for (const path of owned) {
        if (await vault.delete(path)) {
            deleted.push(path);
        }
    }

    return deleted;
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

/** Credential fields a login flow can produce whose values are secrets. */
const LOGIN_SECRET_FIELDS = ["apiKey", "accessToken", "refreshToken", "longLivedToken"] as const;
const LOGIN_PATH_FIELDS = ["authFile", "dataDir"] as const;
const LOGIN_EXPIRY_FIELDS = ["expiresAt", "refreshExpiresAt", "longLivedTokenExpiresAt"] as const;
const SECONDARY_SECRET_FIELDS = ["accessToken", "refreshToken"] as const;

export interface ApplyLoginOutcomeInput {
    /** Account to write. An existing account of this name is merged, not replaced. */
    name: string;
    outcome: LoginOutcome;
    /** Apps to record on an account that lists none yet. */
    apps?: string[];
    /**
     * Apps whose `chat.model` default should point at this account when they have
     * none. Mirrors `addAccountWithDefaults` (`AIConfig.ts:180-196`), which is how
     * a first `tools claude login` made itself the default for `claude` and `ask`.
     */
    defaultForApps?: string[];
}

export interface ApplyLoginOutcomeResult {
    account: AccountEntry;
    created: boolean;
    /** Apps whose empty default this login filled. */
    defaultsSet: string[];
}

/**
 * Write what a login obtained, merging onto an account of the same name.
 *
 * `addAccount` throws on a duplicate name and `editAccount` cannot set secrets,
 * so a re-login could use neither. A plain overwrite is not an option either:
 * a flow returns only the credentials it obtained, so writing them wholesale
 * dropped `longLivedToken`, `secondary`, `label` and `apps` — the bug
 * `mergeAccountEntry` (`AIConfig.ts:64-73`) exists to prevent. A provider switch
 * still replaces the credentials outright, since the stored ones mean nothing to
 * the new vendor.
 */
export async function applyLoginOutcome(input: ApplyLoginOutcomeInput): Promise<ApplyLoginOutcomeResult> {
    // Fail before any write when the provider is unknown, exactly as `addAccount` does.
    providerPlugin(input.outcome.provider);

    const store = await AiConfigStore.load();

    return store.withLock(async (config) => {
        const existing = config.accounts.find((entry) => entry.name === input.name);
        const created = existing === undefined;
        const providerChanged = existing !== undefined && existing.provider !== input.outcome.provider;

        const account: AccountEntry = existing ?? {
            id: slugifyAccountId(input.name, new Set(config.accounts.map((entry) => entry.id))),
            name: input.name,
            provider: input.outcome.provider,
            enabled: true,
            billing: { mode: defaultBilling(input.outcome.provider) },
            credentials: {},
            useEnvApiKey: false,
        };

        if (created) {
            config.accounts.push(account);
        }

        if (providerChanged) {
            // Drop the vault entries BEFORE the config fields that name them.
            // Clearing `credentials` alone left the old vendor's tokens in the
            // encrypted store with nothing left to reach them by: `clearCredentials`
            // works off the config, so those secrets became permanent unreachable
            // orphans in the OS keychain (PR #360 review t11).
            const orphaned = await deleteAccountSecrets(account.id);

            account.provider = input.outcome.provider;
            account.billing = { mode: defaultBilling(input.outcome.provider) };
            account.credentials = {};

            logger.info({ id: account.id, secretsDeleted: orphaned }, "provider switch: deleted the old vault entries");
        }

        if (input.apps?.length && !account.apps?.length) {
            account.apps = [...input.apps];
        }

        const vault = await secrets();
        const incoming = input.outcome.credentials;

        for (const field of LOGIN_SECRET_FIELDS) {
            const value = incoming[field];

            if (value === undefined) {
                continue;
            }

            account.credentials[field] =
                typeof value === "string" ? await vault.set(vaultPathFor(account.id, field), value) : value;
        }

        for (const field of LOGIN_PATH_FIELDS) {
            if (incoming[field] !== undefined) {
                account.credentials[field] = incoming[field];
            }
        }

        for (const field of LOGIN_EXPIRY_FIELDS) {
            if (incoming[field] !== undefined) {
                account.credentials[field] = incoming[field];
            }
        }

        if (incoming.secondary) {
            const merged = { ...account.credentials.secondary, ...incoming.secondary };

            for (const field of SECONDARY_SECRET_FIELDS) {
                const value = incoming.secondary[field];

                if (typeof value === "string") {
                    merged[field] = await vault.set(vaultPathFor(account.id, `secondary.${field}`), value);
                }
            }

            account.credentials.secondary = merged;
        }

        applyAccountFields(account, input.outcome.accountFields);

        const defaultsSet: string[] = [];

        for (const app of input.defaultForApps ?? []) {
            if (config.defaults.app?.[app]?.chat?.model) {
                continue;
            }

            config.defaults.app = { ...(config.defaults.app ?? {}) };
            config.defaults.app[app] = {
                ...(config.defaults.app[app] ?? {}),
                chat: { model: accountRef(account.id) },
            };
            defaultsSet.push(app);
        }

        logger.info(
            { id: account.id, provider: account.provider, created, providerChanged, defaultsSet },
            "applied AI account login outcome"
        );

        return { account, created, defaultsSet };
    });
}

/** Spelled out rather than looped, so a new top-level field cannot be written by accident. */
function applyAccountFields(account: AccountEntry, fields: LoginOutcome["accountFields"]): void {
    if (!fields) {
        return;
    }

    if (fields.label !== undefined) {
        account.label = fields.label;
    }

    if (fields.organizationUuid !== undefined) {
        account.organizationUuid = fields.organizationUuid;
    }

    if (fields.accountUuid !== undefined) {
        account.accountUuid = fields.accountUuid;
    }

    if (fields.subscriptionPlan !== undefined) {
        account.subscriptionPlan = fields.subscriptionPlan;
    }

    if (fields.subscriptionStatus !== undefined) {
        account.subscriptionStatus = fields.subscriptionStatus;
    }

    if (fields.subscriptionCreatedAt !== undefined) {
        account.subscriptionCreatedAt = fields.subscriptionCreatedAt;
    }

    if (fields.subscriptionCheckedAt !== undefined) {
        account.subscriptionCheckedAt = fields.subscriptionCheckedAt;
    }
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

        if (patch.authFile !== undefined) {
            account.credentials.authFile = patch.authFile.length > 0 ? patch.authFile : undefined;
        }

        if (patch.dataDir !== undefined) {
            account.credentials.dataDir = patch.dataDir.length > 0 ? patch.dataDir : undefined;
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

        const secretsDeleted = await deleteAccountSecrets(account.id);

        config.accounts = config.accounts.filter((entry) => entry.id !== account.id);
        logger.info({ id: account.id, referrers: referrers.length, secretsDeleted }, "removed AI account");
        return { account, referrers, secretsDeleted };
    });
}

/** Credential fields a caller may clear without deleting the account. */
export type ClearableCredential =
    | "apiKey"
    | "accessToken"
    | "refreshToken"
    | "longLivedToken"
    | "secondary"
    | "authFile";

const EXPIRY_OF: Partial<Record<ClearableCredential, string[]>> = {
    accessToken: ["expiresAt"],
    refreshToken: ["refreshExpiresAt"],
    longLivedToken: ["longLivedTokenExpiresAt"],
};

/**
 * Vault entries a cleared field owns.
 *
 * Not derivable from the field name: the secondary grant keeps two secrets under
 * a dotted path while the `secondary` config key itself holds none, and
 * `authFile` is a filesystem path with nothing in the vault at all. Deleting
 * `ai/<id>/secondary` would therefore have left both real secrets behind.
 */
const VAULT_PATHS_OF: Record<ClearableCredential, readonly string[]> = {
    apiKey: ["apiKey"],
    accessToken: ["accessToken"],
    refreshToken: ["refreshToken"],
    longLivedToken: ["longLivedToken"],
    secondary: ["secondary.accessToken", "secondary.refreshToken"],
    authFile: [],
};

/**
 * Revoke specific credentials, keeping the account.
 *
 * This exists because a legacy caller CANNOT express a deletion. The v3 view is
 * a projection built from whatever currently resolves (`toV3Account`), so a
 * field the caller deleted and a field whose vault read merely failed look
 * identical by the time they reach `applyV3Tokens`, which skips both. That is
 * how `tools claude logout` came to report "Removed access + refresh token"
 * while the vault refs, and therefore the working credentials, survived.
 *
 * Deleting is destructive, so it is stated explicitly here rather than inferred
 * from an absence.
 */
export async function clearCredentials(
    idOrName: string,
    fields: readonly ClearableCredential[]
): Promise<{ account: AccountEntry; secretsDeleted: string[] }> {
    const store = await AiConfigStore.load();

    return store.withLock(async (config) => {
        const account = requireAccount(config, idOrName);
        const vault = await secrets();
        const secretsDeleted: string[] = [];

        for (const field of fields) {
            for (const owned of VAULT_PATHS_OF[field]) {
                if (await vault.delete(vaultPathFor(account.id, owned))) {
                    secretsDeleted.push(vaultPathFor(account.id, owned));
                }
            }

            delete account.credentials[field];

            for (const expiry of EXPIRY_OF[field] ?? []) {
                delete (account.credentials as Record<string, unknown>)[expiry];
            }
        }

        logger.info({ id: account.id, fields, secretsDeleted }, "cleared AI account credentials");
        return { account, secretsDeleted };
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

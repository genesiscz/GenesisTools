import type { AIAccountEntry, AIConfigData as V3ConfigData } from "@genesiscz/utils/config/ai.types";
import type { ConfigMigration } from "@genesiscz/utils/config/migration";
import { logger } from "@genesiscz/utils/logger";
import { Storage } from "@genesiscz/utils/storage/storage";
import { slugify } from "@genesiscz/utils/string";
import { readDefaultsSnapshot, writeDefaultsSnapshot } from "../defaults-snapshot";
import { migrationAllowedHere } from "../migration-guard";
import { accountRef, isAccountRef, refToId } from "../refs";
import {
    type AccountEntry,
    type AiConfigData,
    type AppDefault,
    accountEntrySchema,
    CONFIG_VERSION,
    isTaskName,
    type TaskDefault,
    type UseEnvApiKey,
} from "../schema";

/** Providers billed by a subscription rather than per token. */
const SUBSCRIPTION_PROVIDERS = new Set(["anthropic-sub", "openai-sub", "grok-sub", "github-copilot"]);

export function slugifyAccountId(name: string, taken: Set<string>): string {
    // The fallback has to guard the BODY, not the whole template. `acc_${""}` is
    // "acc_", which is truthy, so a trailing `|| "acc_account"` never fired — and
    // "acc_" fails the id regex in schema.ts. The migration writes without
    // validating, so any account named only in punctuation or non-ASCII ("---",
    // "日本") produced a v4 file that AiConfigStore then refused to load: a
    // bricked config with no way back, since the file already says version 4.
    // Through the shared `slugify`, which normalises NFD and strips combining
    // marks first. The hand-rolled version skipped that step, so an accented
    // letter contributed NOTHING instead of transliterating: "José" became
    // "acc_jos" rather than "acc_jose".
    // `.toLowerCase()` after slugify, NOT before: slugify preserves case, and the
    // id regex in schema.ts only accepts lowercase.
    const body = slugify(name).toLowerCase().replace(/-/g, "_");
    const base = `acc_${body || "account"}`;
    let candidate = base;
    let suffix = 2;

    while (taken.has(candidate)) {
        candidate = `${base}_${suffix}`;
        suffix += 1;
    }

    taken.add(candidate);
    return candidate;
}

function billingFor(provider: string): AccountEntry["billing"] {
    return SUBSCRIPTION_PROVIDERS.has(provider) ? { mode: "subscription" } : { mode: "metered" };
}

/**
 * v3 stored the env-var NAME in `tokens.apiKeyEnv` and read it live. v4 keeps
 * exactly that behavior under a clearer name, so an account that resolved its
 * key from the environment yesterday still does today.
 */
function envApiKeySettingFor(account: AIAccountEntry, providerDisabledEnv: string | undefined): UseEnvApiKey {
    if (account.tokens.apiKeyEnv) {
        return account.tokens.apiKeyEnv;
    }

    if (providerDisabledEnv) {
        return providerDisabledEnv;
    }

    return false;
}

export function convertAccount(account: AIAccountEntry, id: string, envVariable?: string): AccountEntry {
    const { apiKey, accessToken, refreshToken, longLivedToken, authFile, ...rest } = account.tokens;

    const entry: AccountEntry = {
        id,
        name: account.name,
        provider: account.provider,
        enabled: true,
        billing: billingFor(account.provider),
        credentials: {
            ...(apiKey ? { apiKey } : {}),
            ...(accessToken ? { accessToken } : {}),
            ...(refreshToken ? { refreshToken } : {}),
            ...(longLivedToken ? { longLivedToken } : {}),
            ...(authFile ? { authFile } : {}),
            ...(rest.expiresAt !== undefined ? { expiresAt: rest.expiresAt } : {}),
            ...(rest.refreshExpiresAt !== undefined ? { refreshExpiresAt: rest.refreshExpiresAt } : {}),
            ...(rest.longLivedTokenExpiresAt !== undefined
                ? { longLivedTokenExpiresAt: rest.longLivedTokenExpiresAt }
                : {}),
            ...(account.secondary ? { secondary: account.secondary } : {}),
        },
        useEnvApiKey: envApiKeySettingFor(account, envVariable),
    };

    if (account.label) {
        entry.label = account.label;
    }

    if (account.apps && account.apps.length > 0) {
        entry.apps = [...account.apps];
    }

    if (account.subscriptionCreatedAt) {
        entry.subscriptionCreatedAt = account.subscriptionCreatedAt;
    }

    return entry;
}

/**
 * v3 `apps.<name>.defaults` carried provider/model plus generation settings.
 * Provider and model become the app's chat default; the embedding pair becomes
 * its embed default; the rest stay as top-level knobs.
 */
function convertAppDefaults(defaults: Record<string, unknown> | undefined): AppDefault | undefined {
    if (!defaults) {
        return undefined;
    }

    const { provider, model, embeddingProvider, embeddingModel, temperature, maxTokens, streaming } = defaults as {
        provider?: string;
        model?: string;
        embeddingProvider?: string;
        embeddingModel?: string;
        temperature?: number;
        maxTokens?: number;
        streaming?: boolean;
    };

    const converted: AppDefault = {};

    if (provider || model) {
        converted.chat = { ...(provider ? { provider } : {}), ...(model ? { model } : {}) } as TaskDefault;
    }

    if (embeddingProvider || embeddingModel) {
        converted.embed = {
            ...(embeddingProvider ? { provider: embeddingProvider } : {}),
            ...(embeddingModel ? { model: embeddingModel } : {}),
        } as TaskDefault;
    }

    if (temperature !== undefined) {
        converted.temperature = temperature;
    }

    if (maxTokens !== undefined) {
        converted.maxTokens = maxTokens;
    }

    if (streaming !== undefined) {
        converted.streaming = streaming;
    }

    return Object.keys(converted).length > 0 ? converted : undefined;
}

const STALE_TOKEN_FIELDS = ["apiKey", "accessToken", "refreshToken", "longLivedToken", "authFile"] as const;
const STALE_EXPIRY_FIELDS = ["expiresAt", "refreshExpiresAt", "longLivedTokenExpiresAt"] as const;

function mergeStaleDaemonTokens(kept: AccountEntry, tokens: AIAccountEntry["tokens"] | undefined): void {
    if (!tokens) {
        return;
    }

    for (const field of STALE_TOKEN_FIELDS) {
        const value = tokens[field];

        if (typeof value === "string" && value) {
            kept.credentials[field] = value;
        }
    }

    for (const field of STALE_EXPIRY_FIELDS) {
        const value = tokens[field];

        if (typeof value === "number") {
            kept.credentials[field] = value;
        }
    }
}

export function convertConfig(v3: V3ConfigData): AiConfigData {
    const taken = new Set<string>();
    const idByName = new Map<string, string>();

    // Provider-level `enabled: false` becomes per-account; `envVariable` feeds useEnvApiKey.
    const disabledProviders = new Set<string>();
    const envVarByProvider = new Map<string, string>();
    for (const [provider, config] of Object.entries(v3.providers ?? {})) {
        if (config?.enabled === false) {
            disabledProviders.add(provider);
        }

        if (config?.envVariable) {
            envVarByProvider.set(provider, config.envVariable);
        }
    }

    // HYBRID entries: a pre-v4 binary (a stale daemon, a checkout that has not
    // pulled) loaded an already-migrated config and its own migration stamped
    // `_schemaVersion: 3` back onto the file while preserving the account
    // objects it did not understand. Such an account is already v4 —
    // `credentials` (holding live SecureRefs) and no `tokens` — so running it
    // through the v3 converter crashed on `account.tokens` and bricked the
    // config for every tool on the machine. Pass it through unchanged, and
    // reserve its `id` BEFORE any v3 entry slugifies (the vault paths embed the
    // id, so a collision would re-point another account at its secrets).
    const hybrids = new Map<AIAccountEntry, AccountEntry>();
    for (const account of v3.accounts ?? []) {
        const hybrid = accountEntrySchema.safeParse(account);

        if (hybrid.success) {
            hybrids.set(account, hybrid.data);
            taken.add(hybrid.data.id);
        }
    }

    const accounts: AccountEntry[] = (v3.accounts ?? []).map((account) => {
        const kept = hybrids.get(account);

        if (kept) {
            if (!idByName.has(kept.name)) {
                idByName.set(kept.name, kept.id);
            }

            // The old binary may have refreshed a token AFTER the re-stamp and
            // written it into a v3 `tokens` block beside the untouched
            // `credentials` (the schema parse above silently strips it). The
            // vault then holds the CONSUMED half of a single-use refresh pair,
            // so dropping the block would brick the account. Overlay the fresher
            // values as literals; secretsToVault vaults them later in the chain.
            mergeStaleDaemonTokens(kept, account.tokens);

            logger.info(
                { account: kept.name, id: kept.id },
                "v4 migration: account is already v4 (re-stamped by an older binary); kept verbatim"
            );

            return kept;
        }

        const id = slugifyAccountId(account.name, taken);

        // First wins, because v3 `getAccount(name)` was a `find()` (AIConfig.ts).
        // An unconditional set made a migrated default point at the LAST account
        // sharing a name, silently moving which account pays.
        if (idByName.has(account.name)) {
            logger.warn({ name: account.name }, "v4 migration: duplicate account name; the first one keeps the name");
        } else {
            idByName.set(account.name, id);
        }

        const converted = convertAccount(account, id, envVarByProvider.get(account.provider));
        if (disabledProviders.has(account.provider)) {
            converted.enabled = false;
        }

        return converted;
    });

    const defaults: AiConfigData["defaults"] = {};

    // v3 defaultAccounts is context -> account NAME. Known task names land in
    // defaults.account; everything else was an app context.
    for (const [context, name] of Object.entries(v3.defaultAccounts ?? {})) {
        const id = idByName.get(name);
        if (!id) {
            logger.warn({ context, name }, "v4 migration: default account references an unknown account, dropping");
            continue;
        }

        if (isTaskName(context)) {
            defaults.account = { ...(defaults.account ?? {}), [context]: accountRef(id) };
            continue;
        }

        const app = defaults.app?.[context] ?? {};
        defaults.app = { ...(defaults.app ?? {}), [context]: { ...app, chat: { model: accountRef(id) } } };
    }

    for (const [task, config] of Object.entries(v3.tasks ?? {})) {
        if (!config) {
            continue;
        }

        // Every AIProviderType is also a plugin id EXCEPT "cloud", which was
        // AICloudProvider("auto") — not a provider at all, but "whichever
        // OpenAI-shaped key happens to be set". Copying it verbatim produced a
        // v4 default naming a plugin that does not exist, and `tools ai
        // summarize` then died with `No enabled account for provider "cloud"`
        // on any freshly migrated home. Dropping it is the faithful
        // translation: the availability chain in tasks/resolve-task.ts already
        // expands "cloud" into openai/groq/openrouter at the same position, so
        // an absent provider resolves to exactly what "auto" meant.
        const provider = config.provider === "cloud" ? undefined : config.provider;

        if (config.provider === "cloud") {
            logger.info(
                { task },
                'v4 migration: dropping the legacy "cloud" task provider, the fallback chain covers it'
            );
        }

        defaults.task = {
            ...(defaults.task ?? {}),
            [task]: {
                ...(provider ? { provider } : {}),
                ...(config.model ? { model: config.model } : {}),
            },
        };
    }

    for (const [app, config] of Object.entries(v3.apps ?? {})) {
        const converted = convertAppDefaults(config?.defaults as Record<string, unknown> | undefined);
        if (!converted) {
            continue;
        }

        defaults.app = { ...(defaults.app ?? {}), [app]: { ...(defaults.app?.[app] ?? {}), ...converted } };
    }

    const disabled = [...disabledProviders].sort();

    return {
        version: CONFIG_VERSION,
        // The pre-v4-binary armor; see the field's doc in schema.ts.
        _schemaVersion: 3,
        accounts,
        defaults,
        ...(disabled.length > 0 ? { disabledProviders: disabled } : {}),
    };
}

/**
 * Resolved per call, never at module scope: `Storage` captures the root from
 * GENESIS_TOOLS_HOME when it is constructed, so a module-level instance would
 * bind whatever the environment held at import time.
 */
function aiStorage(): Storage {
    return new Storage("ai");
}

export const migrateConfigV4: ConfigMigration = {
    id: "2026-08-configV4",
    description: "Convert the AI config to v4: account ids, credentials block, account refs",

    shouldRun: async () => {
        const raw = await aiStorage().getConfig<{ version?: number; _schemaVersion?: number; accounts?: unknown }>();
        if (!raw || Object.keys(raw).length === 0) {
            return false;
        }

        if (!migrationAllowedHere()) {
            return false;
        }

        // Only a recognisable OLDER config migrates. `version !== 4` alone also
        // matched corrupt files and configs from newer builds, so run() would
        // attempt to convert garbage and log a TypeError on every load before
        // the reader's own loud schema error. Unrecognisable input is the
        // reader's problem, not a migration's.
        const version = raw.version ?? raw._schemaVersion;
        if (typeof version !== "number" || version >= CONFIG_VERSION) {
            return false;
        }

        return raw.accounts === undefined || Array.isArray(raw.accounts);
    },

    run: async () => {
        const storage = aiStorage();

        await storage.withConfigLock(async () => {
            const raw = await storage.getConfig<V3ConfigData & { version?: number; _schemaVersion?: number }>();

            // Re-check under the lock with the SAME rule shouldRun() used. An
            // equality test on CONFIG_VERSION let a v5 file through, which would
            // then be run through the v3 converter and written back as v4,
            // dropping every field this converter does not know about.
            const version = raw?.version ?? raw?._schemaVersion;

            if (
                !raw ||
                typeof version !== "number" ||
                version >= CONFIG_VERSION ||
                (raw.accounts !== undefined && !Array.isArray(raw.accounts))
            ) {
                return;
            }

            const converted = convertConfig(raw);

            // An old binary's rewrite drops the v4 `defaults` block (accounts
            // survive by reference; defaults do not). The snapshot in
            // defaults.v4.json is the copy old code cannot touch, and it is
            // authoritative by construction (written on every v4 write) — so it
            // is consulted whenever the conversion produced no defaults, NOT
            // only when a v4-shaped account betrays the rewrite. An old binary
            // that converted the accounts too (a token refresh through its own
            // save path) leaves no hybrid to detect, and gating on one would
            // hand that case the old binary's fallback values instead.
            const noDefaults =
                Object.keys(converted.defaults.account ?? {}).length === 0 &&
                Object.keys(converted.defaults.app ?? {}).length === 0;

            if (noDefaults) {
                const snapshot = readDefaultsSnapshot(storage);

                if (snapshot) {
                    // The snapshot may predate an old-binary account REMOVAL, so
                    // its refs are filtered against the accounts that actually
                    // survived — a restored default must never point at a ghost.
                    const ids = new Set(converted.accounts.map((entry) => entry.id));
                    const account = Object.fromEntries(
                        Object.entries(snapshot.account ?? {}).filter(
                            ([, ref]) => isAccountRef(ref) && ids.has(refToId(ref))
                        )
                    );
                    converted.defaults = {
                        ...snapshot,
                        ...(Object.keys(account).length > 0 ? { account } : { account: undefined }),
                    };
                    logger.info("v4 migration: restored defaults from the snapshot after an old-binary rewrite");
                }
            }

            await storage.setConfig(converted);
            writeDefaultsSnapshot(storage, converted.defaults);
            logger.info(
                { accounts: converted.accounts.length, from: raw._schemaVersion ?? "unknown" },
                "migrated AI config to v4"
            );
        });
    },
};

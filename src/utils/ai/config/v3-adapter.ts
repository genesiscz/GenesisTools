import type { AIAccountEntry, AIProvider, AISecondaryLogin } from "@genesiscz/utils/config/ai.types";
import { logger } from "@genesiscz/utils/logger";
import { type MaybeSecret, resolveSecretSync, secrets } from "@genesiscz/utils/security";
import { accountRefIn } from "./refs";
import type { AccountEntry, AiConfigData } from "./schema";

/**
 * Bidirectional bridge between the v4 store and the v3 shapes that every
 * existing `AIConfig` caller still speaks. It exists so the facade can be
 * behavior-preserving during the migration window; it disappears with the
 * facade once each surface moves to the store directly.
 */

const SECRET_FIELDS = ["apiKey", "accessToken", "refreshToken", "longLivedToken"] as const;

/** Apps that name this account in their defaults — v3 stored this on the account. */
export function appsFor(config: AiConfigData, accountId: string): string[] {
    const target = `@account/${accountId}`;
    const apps: string[] = [];

    for (const [app, defaults] of Object.entries(config.defaults.app ?? {})) {
        const referenced = Object.values(defaults ?? {}).some(
            (value) => typeof value === "object" && value !== null && accountRefIn(String(value.model ?? "")) === target
        );

        if (referenced) {
            apps.push(app);
        }
    }

    return apps;
}

function toSecondary(account: AccountEntry): AISecondaryLogin | undefined {
    const secondary = account.credentials.secondary;
    if (!secondary) {
        return undefined;
    }

    return {
        ...secondary,
        accessToken: resolveSecretSync(secondary.accessToken) ?? "",
        refreshToken: resolveSecretSync(secondary.refreshToken) ?? "",
    };
}

/** v4 account seen through v3 eyes. Vault refs are resolved, so callers see values. */
export function toV3Account(account: AccountEntry, config: AiConfigData): AIAccountEntry {
    const { credentials } = account;

    const entry: AIAccountEntry = {
        name: account.name,
        provider: account.provider as AIProvider,
        tokens: {
            ...(resolveSecretSync(credentials.apiKey) ? { apiKey: resolveSecretSync(credentials.apiKey) } : {}),
            ...(resolveSecretSync(credentials.accessToken)
                ? { accessToken: resolveSecretSync(credentials.accessToken) }
                : {}),
            ...(resolveSecretSync(credentials.refreshToken)
                ? { refreshToken: resolveSecretSync(credentials.refreshToken) }
                : {}),
            ...(resolveSecretSync(credentials.longLivedToken)
                ? { longLivedToken: resolveSecretSync(credentials.longLivedToken) }
                : {}),
            ...(credentials.authFile ? { authFile: credentials.authFile } : {}),
            ...(credentials.expiresAt !== undefined ? { expiresAt: credentials.expiresAt } : {}),
            ...(credentials.refreshExpiresAt !== undefined ? { refreshExpiresAt: credentials.refreshExpiresAt } : {}),
            ...(credentials.longLivedTokenExpiresAt !== undefined
                ? { longLivedTokenExpiresAt: credentials.longLivedTokenExpiresAt }
                : {}),
            // v3's apiKeyEnv was a single variable name; only the string form of
            // useEnvApiKey round-trips exactly, which is what migrated accounts carry.
            ...(typeof account.useEnvApiKey === "string" ? { apiKeyEnv: account.useEnvApiKey } : {}),
        },
    };

    const secondary = toSecondary(account);
    if (secondary) {
        entry.secondary = secondary;
    }

    if (account.label) {
        entry.label = account.label;
    }

    if (account.subscriptionCreatedAt) {
        entry.subscriptionCreatedAt = account.subscriptionCreatedAt;
    }

    // v3 kept this on the account; v4 does too, with app-default references as a
    // fallback for accounts that predate the field.
    const apps = account.apps ?? appsFor(config, account.id);
    if (apps.length > 0) {
        entry.apps = [...apps];
    }

    return entry;
}

/**
 * Store a credential in the vault, falling back to a literal when no master key
 * is reachable (headless process, keychain locked).
 *
 * Refusing to write would be worse than storing plaintext: the caller is usually
 * a login flow persisting a token it just obtained, and throwing loses it
 * outright. The value is recorded as v3 would have recorded it and the next
 * interactive run vaults it, with a warning so the state is never silent.
 */
async function vaultOrLiteral(path: string, value: string): Promise<MaybeSecret> {
    try {
        const store = await secrets();
        return await store.set(path, value);
    } catch (err) {
        logger.warn({ err, path }, "vault unavailable; storing credential as a literal for now");
        return value;
    }
}

/**
 * Apply v3-shaped token updates onto a v4 account, writing any new secret value
 * into the vault so a legacy caller cannot reintroduce plaintext into the config.
 */
export async function applyV3Tokens(account: AccountEntry, tokens: AIAccountEntry["tokens"]): Promise<void> {
    for (const field of SECRET_FIELDS) {
        const value = tokens[field];
        if (typeof value !== "string") {
            continue;
        }

        account.credentials[field] = await vaultOrLiteral(`ai/${account.id}/${field}`, value);
    }

    if (tokens.authFile !== undefined) {
        account.credentials.authFile = tokens.authFile;
    }

    if (tokens.expiresAt !== undefined) {
        account.credentials.expiresAt = tokens.expiresAt;
    }

    if (tokens.refreshExpiresAt !== undefined) {
        account.credentials.refreshExpiresAt = tokens.refreshExpiresAt;
    }

    if (tokens.longLivedTokenExpiresAt !== undefined) {
        account.credentials.longLivedTokenExpiresAt = tokens.longLivedTokenExpiresAt;
    }

    if (tokens.apiKeyEnv) {
        account.useEnvApiKey = tokens.apiKeyEnv;
    }
}

export async function applyV3Secondary(account: AccountEntry, secondary: AISecondaryLogin): Promise<void> {
    const { accessToken, refreshToken, ...rest } = secondary;

    account.credentials.secondary = {
        ...rest,
        ...(accessToken
            ? { accessToken: await vaultOrLiteral(`ai/${account.id}/secondary.accessToken`, accessToken) }
            : {}),
        ...(refreshToken
            ? { refreshToken: await vaultOrLiteral(`ai/${account.id}/secondary.refreshToken`, refreshToken) }
            : {}),
    };
}

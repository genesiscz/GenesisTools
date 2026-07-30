import { createHash, timingSafeEqual } from "node:crypto";
import { statSync } from "node:fs";
import { extractBearerToken } from "@app/ai-proxy/lib/auth-middleware";
import type { AiProxyClientConfig, AiProxyConfig, AiProxyProviderType } from "@app/ai-proxy/lib/types";
import { logger } from "@genesiscz/utils/logger";
import { isSecureRef, resolveSecret } from "@genesiscz/utils/security";
import { vaultAdmin } from "@genesiscz/utils/security/SecretStore";

export const OWNER_CLIENT_NAME = "owner";

const MIN_KEY_LENGTH = 16;

/**
 * Provider types that bill a personal subscription (Claude Max, ChatGPT, Grok,
 * Copilot). Serving these to third parties is subscription resale — a ToS
 * violation — so ONLY the owner key (proxyApiKey) may ever route to them.
 * FROZEN: config cannot grant these to a client; validation rejects the attempt.
 */
export const SUBSCRIPTION_PROVIDER_TYPES: ReadonlySet<AiProxyProviderType> = new Set([
    "grok-subscription",
    "github-copilot-subscription",
    "anthropic-subscription",
    "openai-subscription",
]);

/** Every known provider type — catches allowedProviders typos at validation time. */
export const VALID_PROVIDER_TYPES: ReadonlySet<AiProxyProviderType> = new Set([
    ...SUBSCRIPTION_PROVIDER_TYPES,
    "xai-api-key",
    "openai",
]);

export function validateClients(clients: AiProxyClientConfig[] | undefined): string[] {
    if (clients === undefined) {
        return [];
    }

    if (!Array.isArray(clients)) {
        return ["clients config must be an array of client entries"];
    }

    if (clients.length === 0) {
        return [];
    }

    const problems: string[] = [];
    const names = new Set<string>();
    const keys = new Set<string>();

    for (const client of clients) {
        if (typeof client.name !== "string" || !/^[a-zA-Z0-9_-]+$/.test(client.name)) {
            problems.push(
                `client name ${SafeStr(client.name)} must be a non-empty string of alphanumerics, hyphens, or underscores`
            );
        }

        if (client.name === OWNER_CLIENT_NAME) {
            problems.push(`client name "${OWNER_CLIENT_NAME}" is reserved for the proxyApiKey identity`);
        }

        if (names.has(client.name)) {
            problems.push(`duplicate client name: ${client.name}`);
        }

        names.add(client.name);

        // A SecureRef is validated by its shape; its length lives in the vault
        // and reading it here would need the master key at config-validation time.
        if (isSecureRef(client.key)) {
            const identity = client.key.path;

            if (keys.has(identity)) {
                problems.push(`duplicate client key (client "${client.name}")`);
            }

            keys.add(identity);
        } else if (typeof client.key !== "string" || client.key.length < MIN_KEY_LENGTH) {
            problems.push(
                `client "${client.name}": key must be a vault reference or a string of at least ${MIN_KEY_LENGTH} characters`
            );
        } else {
            if (keys.has(client.key)) {
                problems.push(`duplicate client key (client "${client.name}")`);
            }

            keys.add(client.key);
        }

        if (client.allowedProviders !== undefined && !Array.isArray(client.allowedProviders)) {
            problems.push(`client "${client.name}": allowedProviders must be an array`);
        } else {
            for (const provider of client.allowedProviders ?? []) {
                if (!VALID_PROVIDER_TYPES.has(provider)) {
                    problems.push(`client "${client.name}": unknown provider type "${provider}"`);
                } else if (SUBSCRIPTION_PROVIDER_TYPES.has(provider)) {
                    problems.push(
                        `client "${client.name}": subscription providers cannot be granted to clients (${provider})`
                    );
                }
            }
        }
    }

    return problems;
}

function SafeStr(value: string | undefined): string {
    return value === undefined ? "<missing>" : `"${value}"`;
}

export interface ResolvedClient {
    name: string;
    isOwner: boolean;
    config?: AiProxyClientConfig;
}

function digestsEqual(a: string, b: string): boolean {
    const hashA = createHash("sha256").update(a).digest();
    const hashB = createHash("sha256").update(b).digest();
    return timingSafeEqual(hashA, hashB);
}

/**
 * Resolve the presented Bearer to a client identity. The legacy proxyApiKey is
 * the implicit "owner". No early exit: every candidate is compared so a match's
 * list position is not observable via timing.
 *
 * Async because a client key may be a vault pointer rather than a literal. A
 * pointer that will not resolve (no master key, entry deleted) is skipped like
 * any non-matching key — the request gets a 401, never someone else's identity.
 */
export async function resolveClient(req: Request, config: AiProxyConfig): Promise<ResolvedClient | null> {
    const token = extractBearerToken(req);

    if (!token) {
        return null;
    }

    let resolved: ResolvedClient | null = null;

    if (typeof config.proxyApiKey === "string" && digestsEqual(token, config.proxyApiKey)) {
        resolved = { name: OWNER_CLIENT_NAME, isOwner: true };
    }

    const clients = Array.isArray(config.clients) ? config.clients : [];

    // `statSync` blocks, and every candidate in this loop observes the same
    // vault generation, so the stamp is taken ONCE for the whole loop instead of
    // once per client. Taking it only when some client actually points into the
    // vault keeps a plaintext-only config at zero stats per request.
    const stamp = clients.some((client) => isSecureRef(client.key)) ? vaultStamp() : undefined;

    for (const client of clients) {
        const key = await clientKey(client, stamp);

        if (key === undefined) {
            continue;
        }

        const matches = digestsEqual(token, key);

        if (matches && !client.disabled && resolved === null) {
            resolved = { name: client.name, isOwner: false, config: client };
        }
    }

    return resolved;
}

/**
 * Which vault a set of cached keys came from: its resolved path AND its mtime.
 *
 * The path is half the identity because `vaultAdmin.path()` is resolved
 * dynamically from the config root, so ONE process can legitimately read two
 * different vaults over its lifetime. Keyed on mtime alone, a SecureRef with the
 * same logical path would be served plaintext decrypted from the vault that was
 * current a moment ago, authenticating a key that does not exist in the vault
 * now selected.
 */
interface VaultStamp {
    path: string;
    mtimeMs: number;
}

/**
 * Resolved vault keys, valid only for the vault generation in `stamp`.
 *
 * `resolveSecret` reads and parses the whole vault, derives an HKDF subkey and
 * runs an AES-GCM decrypt, with no caching of its own. `resolveClient` calls it
 * once PER CLIENT PER REQUEST while comparing candidates, so a five-client proxy
 * paid five file reads, five parses and five decrypts on every
 * `/v1/chat/completions`. Stamping keeps a rotated or edited vault picked up
 * immediately (mtime carries sub-millisecond precision, so back-to-back writes
 * do not alias), and nothing about the comparison changes: the loop still visits
 * every candidate in constant position and still hashes with `digestsEqual`.
 */
let keyCache: { stamp: VaultStamp; keys: Map<string, string | undefined> } | null = null;

function vaultStamp(): VaultStamp {
    const path = vaultAdmin.path();

    try {
        return { path, mtimeMs: statSync(path).mtimeMs };
    } catch (err) {
        // No vault yet is normal on a plaintext-only config; a zero stamp simply
        // means "nothing cached from a vault that does not exist".
        logger.debug({ err }, "ai-proxy: vault not present for the client-key cache");
        return { path, mtimeMs: 0 };
    }
}

function cachedKeys(stamp: VaultStamp): Map<string, string | undefined> {
    if (!keyCache || keyCache.stamp.path !== stamp.path || keyCache.stamp.mtimeMs !== stamp.mtimeMs) {
        keyCache = { stamp, keys: new Map() };
    }

    return keyCache.keys;
}

/** Drop cached plaintext. Tests that swap config roots in-process need this. */
export function _resetClientKeyCacheForTest(): void {
    keyCache = null;
}

async function clientKey(client: AiProxyClientConfig, stamp: VaultStamp | undefined): Promise<string | undefined> {
    if (typeof client.key === "string") {
        return client.key;
    }

    // Not a vault pointer, or there is no vault generation to read it against.
    if (!isSecureRef(client.key) || stamp === undefined) {
        return undefined;
    }

    const keys = cachedKeys(stamp);

    if (keys.has(client.key.path)) {
        return keys.get(client.key.path);
    }

    const value = await resolveSecret(client.key);
    keys.set(client.key.path, value);

    if (value === undefined) {
        logger.warn(
            { client: client.name, path: client.key.path },
            "ai-proxy: client key is a vault reference that did not resolve — that client cannot authenticate"
        );
    }

    return value;
}

/**
 * Returns null when the client may route to the provider type, else a
 * human-readable denial. Subscription providers are denied to every non-owner
 * client unconditionally — this is the no-resale invariant; allowedProviders
 * cannot override it (and validation already rejects the attempt).
 */
export function clientProviderDenial(client: ResolvedClient, providerType: AiProxyProviderType): string | null {
    if (client.isOwner) {
        return null;
    }

    if (SUBSCRIPTION_PROVIDER_TYPES.has(providerType)) {
        return `provider "${providerType}" bills a personal subscription and is owner-only`;
    }

    const allowed = client.config?.allowedProviders;

    if (Array.isArray(allowed) && !allowed.includes(providerType)) {
        return `provider "${providerType}" is not allowed for client "${client.name}"`;
    }

    return null;
}

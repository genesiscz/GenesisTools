import { createHash, timingSafeEqual } from "node:crypto";
import { extractBearerToken } from "@app/ai-proxy/lib/auth-middleware";
import type { AiProxyClientConfig, AiProxyConfig, AiProxyProviderType } from "@app/ai-proxy/lib/types";

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

        if (typeof client.key !== "string" || client.key.length < MIN_KEY_LENGTH) {
            problems.push(`client "${client.name}": key must be a string of at least ${MIN_KEY_LENGTH} characters`);
        }

        if (keys.has(client.key)) {
            problems.push(`duplicate client key (client "${client.name}")`);
        }

        keys.add(client.key);

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
 */
export function resolveClient(req: Request, config: AiProxyConfig): ResolvedClient | null {
    const token = extractBearerToken(req);

    if (!token) {
        return null;
    }

    let resolved: ResolvedClient | null = null;

    if (typeof config.proxyApiKey === "string" && digestsEqual(token, config.proxyApiKey)) {
        resolved = { name: OWNER_CLIENT_NAME, isOwner: true };
    }

    for (const client of Array.isArray(config.clients) ? config.clients : []) {
        if (typeof client.key !== "string") {
            continue;
        }

        const matches = digestsEqual(token, client.key);

        if (matches && !client.disabled && resolved === null) {
            resolved = { name: client.name, isOwner: false, config: client };
        }
    }

    return resolved;
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

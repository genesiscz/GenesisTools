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

export function validateClients(clients: AiProxyClientConfig[] | undefined): string[] {
    if (!clients || clients.length === 0) {
        return [];
    }

    const problems: string[] = [];
    const names = new Set<string>();
    const keys = new Set<string>();

    for (const client of clients) {
        if (!client.name || client.name.trim() !== client.name || client.name.length === 0) {
            problems.push(`client name ${SafeStr(client.name)} is empty or has surrounding whitespace`);
        }

        if (client.name === OWNER_CLIENT_NAME) {
            problems.push(`client name "${OWNER_CLIENT_NAME}" is reserved for the proxyApiKey identity`);
        }

        if (names.has(client.name)) {
            problems.push(`duplicate client name: ${client.name}`);
        }

        names.add(client.name);

        if (!client.key || client.key.length < MIN_KEY_LENGTH) {
            problems.push(`client "${client.name}": key must be at least ${MIN_KEY_LENGTH} characters`);
        }

        if (keys.has(client.key)) {
            problems.push(`duplicate client key (client "${client.name}")`);
        }

        keys.add(client.key);

        for (const provider of client.allowedProviders ?? []) {
            if (SUBSCRIPTION_PROVIDER_TYPES.has(provider)) {
                problems.push(
                    `client "${client.name}": subscription providers cannot be granted to clients (${provider})`
                );
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

    if (digestsEqual(token, config.proxyApiKey)) {
        resolved = { name: OWNER_CLIENT_NAME, isOwner: true };
    }

    for (const client of config.clients ?? []) {
        const matches = digestsEqual(token, client.key);

        if (matches && !client.disabled && resolved === null) {
            resolved = { name: client.name, isOwner: false, config: client };
        }
    }

    return resolved;
}

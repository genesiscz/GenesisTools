import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { mcpFetch, readJsonRecord } from "./fetch.ts";
import { assertDiscoveryTarget } from "./url-policy.ts";

export interface ProtectedResourceMetadata {
    resource: string;
    authorization_servers: string[];
    scopes_supported?: string[];
    bearer_methods_supported?: string[];
}

export interface AuthorizationServerMetadata {
    issuer: string;
    authorization_endpoint: string;
    token_endpoint: string;
    registration_endpoint?: string;
    device_authorization_endpoint?: string;
    code_challenge_methods_supported?: string[];
    grant_types_supported?: string[];
    token_endpoint_auth_methods_supported?: string[];
    scopes_supported?: string[];
}

export interface DiscoveryResult {
    prm: ProtectedResourceMetadata;
    as: AuthorizationServerMetadata;
    prmUrl: string;
}

function parseResourceMetadata(wwwAuthenticate: string | null): string | undefined {
    if (!wwwAuthenticate) {
        return undefined;
    }

    const match = wwwAuthenticate.match(/resource_metadata="([^"]+)"/i);

    return match?.[1];
}

const MAX_DISCOVERY_REDIRECTS = 5;

/**
 * No credential travels with this request and a well-known document is allowed to
 * redirect, but the destination is chosen by the remote server, so each hop is checked
 * against `origin` BEFORE it is issued. `redirect: "follow"` would issue the next
 * request before we could look at it, which is the whole SSRF primitive.
 */
async function getJson(url: string, origin: string): Promise<unknown | undefined> {
    let current = (await assertDiscoveryTarget(url, origin)).toString();

    for (let hop = 0; hop <= MAX_DISCOVERY_REDIRECTS; hop += 1) {
        const response = await mcpFetch(current, { headers: { Accept: "application/json" } });

        if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get("location");

            if (!location) {
                return undefined;
            }

            current = (await assertDiscoveryTarget(new URL(location, current).toString(), origin)).toString();
            continue;
        }

        if (!response.ok) {
            return undefined;
        }

        const { json } = await readJsonRecord(response);

        return json;
    }

    logger.warn({ url, origin }, "discovery gave up after too many redirects");

    return undefined;
}

function asPrm(value: unknown): ProtectedResourceMetadata | undefined {
    if (!value || typeof value !== "object") {
        return undefined;
    }

    const rec = value as Record<string, unknown>;

    if (typeof rec.resource !== "string" || !Array.isArray(rec.authorization_servers)) {
        return undefined;
    }

    // A non-string element reaches `new URL(issuer)` in discoverMcp and fails there with
    // an unrelated message, so reject the document instead of the symptom.
    if (!rec.authorization_servers.every((entry) => typeof entry === "string" && entry.length > 0)) {
        return undefined;
    }

    return rec as unknown as ProtectedResourceMetadata;
}

function asAs(value: unknown): AuthorizationServerMetadata | undefined {
    if (!value || typeof value !== "object") {
        return undefined;
    }

    const rec = value as Record<string, unknown>;

    // authorization_endpoint is not optional on AuthorizationServerMetadata, and login.ts
    // feeds it straight to `new URL(...)`. Without this check the assertion below lies.
    if (
        typeof rec.issuer !== "string" ||
        typeof rec.token_endpoint !== "string" ||
        typeof rec.authorization_endpoint !== "string"
    ) {
        return undefined;
    }

    return rec as unknown as AuthorizationServerMetadata;
}

export async function discoverResource(mcpUrl: string): Promise<{ prm: ProtectedResourceMetadata; prmUrl: string }> {
    const resource = new URL(mcpUrl);
    let prmUrl = parseResourceMetadata(null);

    const probe = await mcpFetch(mcpUrl, {
        method: "POST",
        headers: {
            Accept: "application/json, text/event-stream",
            "Content-Type": "application/json",
        },
        body: SafeJSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
                protocolVersion: "2025-03-26",
                capabilities: {},
                clientInfo: { name: "genesis-tools-mcp-manager", version: "0" },
            },
        }),
    });

    prmUrl = parseResourceMetadata(probe.headers.get("www-authenticate"));

    if (!prmUrl) {
        const pathScoped = `${resource.origin}/.well-known/oauth-protected-resource${resource.pathname.replace(/\/+$/, "")}`;
        const root = `${resource.origin}/.well-known/oauth-protected-resource`;
        const fromPath = asPrm(await getJson(pathScoped, mcpUrl));

        if (fromPath) {
            return { prm: fromPath, prmUrl: pathScoped };
        }

        const fromRoot = asPrm(await getJson(root, mcpUrl));

        if (fromRoot) {
            return { prm: fromRoot, prmUrl: root };
        }

        throw new Error(`No protected resource metadata for ${mcpUrl}`);
    }

    const prm = asPrm(await getJson(prmUrl, mcpUrl));

    if (!prm) {
        throw new Error(`Protected resource metadata at ${prmUrl} is unusable`);
    }

    return { prm, prmUrl };
}

export async function discoverAuthorizationServer(
    issuer: string,
    origin: string = issuer
): Promise<AuthorizationServerMetadata> {
    const url = await assertDiscoveryTarget(issuer, origin);
    const candidates: string[] = [];

    if (url.pathname && url.pathname !== "/") {
        const trimmed = url.pathname.replace(/\/+$/, "");
        candidates.push(`${url.origin}/.well-known/oauth-authorization-server${trimmed}`);
        candidates.push(`${url.origin}/.well-known/openid-configuration${trimmed}`);
        candidates.push(`${url.origin}${trimmed}/.well-known/openid-configuration`);
    } else {
        candidates.push(`${url.origin}/.well-known/oauth-authorization-server`);
        candidates.push(`${url.origin}/.well-known/openid-configuration`);
    }

    for (const candidate of candidates) {
        const meta = asAs(await getJson(candidate, origin));

        if (meta) {
            return meta;
        }
    }

    throw new Error(`No authorization server metadata for ${issuer}`);
}

export async function discoverMcp(mcpUrl: string): Promise<DiscoveryResult> {
    const { prm, prmUrl } = await discoverResource(mcpUrl);
    const issuer = prm.authorization_servers[0];

    if (!issuer) {
        throw new Error(`Protected resource ${prm.resource} lists no authorization servers`);
    }

    const as = await discoverAuthorizationServer(issuer, mcpUrl);

    return { prm, as, prmUrl };
}

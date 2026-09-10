import { SafeJSON } from "@genesiscz/utils/json";
import { mcpFetch, readJsonRecord } from "./fetch.ts";

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

async function getJson(url: string): Promise<unknown | undefined> {
    const response = await mcpFetch(url, { headers: { Accept: "application/json" } });

    if (!response.ok) {
        return undefined;
    }

    const { json } = await readJsonRecord(response);

    return json;
}

function asPrm(value: unknown): ProtectedResourceMetadata | undefined {
    if (!value || typeof value !== "object") {
        return undefined;
    }

    const rec = value as Record<string, unknown>;

    if (typeof rec.resource !== "string" || !Array.isArray(rec.authorization_servers)) {
        return undefined;
    }

    return rec as unknown as ProtectedResourceMetadata;
}

function asAs(value: unknown): AuthorizationServerMetadata | undefined {
    if (!value || typeof value !== "object") {
        return undefined;
    }

    const rec = value as Record<string, unknown>;

    if (typeof rec.issuer !== "string" || typeof rec.token_endpoint !== "string") {
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
        const fromPath = asPrm(await getJson(pathScoped));

        if (fromPath) {
            return { prm: fromPath, prmUrl: pathScoped };
        }

        const fromRoot = asPrm(await getJson(root));

        if (fromRoot) {
            return { prm: fromRoot, prmUrl: root };
        }

        throw new Error(`No protected resource metadata for ${mcpUrl}`);
    }

    const prm = asPrm(await getJson(prmUrl));

    if (!prm) {
        throw new Error(`Protected resource metadata at ${prmUrl} is unusable`);
    }

    return { prm, prmUrl };
}

export async function discoverAuthorizationServer(issuer: string): Promise<AuthorizationServerMetadata> {
    const url = new URL(issuer);
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
        const meta = asAs(await getJson(candidate));

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

    const as = await discoverAuthorizationServer(issuer);

    return { prm, as, prmUrl };
}

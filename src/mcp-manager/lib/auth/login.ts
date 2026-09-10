import type { UnifiedMCPServerConfig } from "@app/mcp-manager/utils/providers/types.js";
import { startCallbackListener } from "@genesiscz/utils/ai/oauth/callback-server";
import { presentAuthorizationUrl } from "@genesiscz/utils/ai/oauth/login-ui";
import { generatePkcePair } from "@genesiscz/utils/ai/oauth/pkce";
import { SafeJSON } from "@genesiscz/utils/json";
import { pollDeviceToken, startDeviceFlow } from "@genesiscz/utils/oauth/device-flow";
import type { DeviceFlowConfig } from "@genesiscz/utils/oauth/types";
import { discoverMcp } from "./discovery.ts";
import { mcpFetch, readJsonRecord } from "./fetch.ts";
import { clientNameFor, policyFor, serverAuth } from "./policy.ts";
import { oauthClientPresetFor, suggestedLoginCommand } from "./presets.ts";
import { writeServerTokens } from "./secrets.ts";
import { writeAuthStatus } from "./status.ts";

export interface LoginOptions {
    server: string;
    config: UnifiedMCPServerConfig;
    device?: boolean;
    yes?: boolean;
    clientName?: string;
}

export interface LoginResult {
    resource: string;
    issuer: string;
    tokenEndpoint: string;
    clientId: string;
    expiresAt: number;
}

function form(body: Record<string, string>): URLSearchParams {
    return new URLSearchParams(body);
}

async function registerClient(
    registrationEndpoint: string,
    redirectUri: string,
    clientName: string,
    hint: { server: string; mcpUrl: string }
): Promise<{
    client_id: string;
    client_secret?: string;
}> {
    const methods = ["client_secret_post", "none"] as const;
    let lastBody = "";
    let lastStatus = 0;

    for (const method of methods) {
        const response = await mcpFetch(registrationEndpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: SafeJSON.stringify({
                client_name: clientName,
                redirect_uris: [redirectUri],
                grant_types: ["authorization_code", "refresh_token"],
                response_types: ["code"],
                token_endpoint_auth_method: method,
            }),
        });
        const { json, text } = await readJsonRecord(response);
        lastStatus = response.status;
        lastBody = json ? SafeJSON.stringify(json).slice(0, 400) : text.slice(0, 400);

        if (response.ok && typeof json?.client_id === "string") {
            return {
                client_id: json.client_id,
                client_secret: typeof json.client_secret === "string" ? json.client_secret : undefined,
            };
        }
    }

    throw new Error(
        `Dynamic client registration failed (HTTP ${lastStatus}): ${lastBody}${dcrRefusalHint(hint.server, hint.mcpUrl, lastStatus)}`
    );
}

function dcrRefusalHint(server: string, mcpUrl: string, status: number): string {
    if (status !== 403) {
        return "";
    }

    const preset = oauthClientPresetFor(mcpUrl);

    if (preset) {
        return ` ${preset.issue} ${suggestedLoginCommand(server, preset.clientNames[0]?.value ?? "Claude Code")}`;
    }

    return ' This authorization server refused dynamic client registration. Try --client-name "Claude Code".';
}

async function exchangeCode(opts: {
    tokenEndpoint: string;
    code: string;
    redirectUri: string;
    clientId: string;
    clientSecret?: string;
    verifier: string;
    resource: string;
}): Promise<{ access_token: string; refresh_token?: string; expires_in?: number }> {
    const body: Record<string, string> = {
        grant_type: "authorization_code",
        code: opts.code,
        redirect_uri: opts.redirectUri,
        client_id: opts.clientId,
        code_verifier: opts.verifier,
        resource: opts.resource,
    };

    if (opts.clientSecret) {
        body.client_secret = opts.clientSecret;
    }

    const response = await mcpFetch(opts.tokenEndpoint, {
        method: "POST",
        headers: {
            Accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form(body),
    });
    const { json, text } = await readJsonRecord(response);
    const accessToken = json?.access_token;

    if (!response.ok || typeof accessToken !== "string") {
        throw new Error(
            `Token exchange failed (HTTP ${response.status}): ${(json ? SafeJSON.stringify(json) : text).slice(0, 400)}`
        );
    }

    return {
        access_token: accessToken,
        refresh_token: typeof json?.refresh_token === "string" ? json.refresh_token : undefined,
        expires_in: typeof json?.expires_in === "number" ? json.expires_in : undefined,
    };
}

export async function loginMcpServer(options: LoginOptions): Promise<LoginResult> {
    const auth = serverAuth(options.config);

    if (auth?.kind === "none") {
        throw new Error(`${options.server} has auth.kind none. OAuth login does not apply.`);
    }

    if (auth?.kind === "bearer") {
        throw new Error(`${options.server} is bearer auth. Paste a token with a later --token path, not OAuth login.`);
    }

    const mcpUrl = options.config.url ?? options.config.httpUrl;

    if (!mcpUrl) {
        throw new Error(`${options.server} has no HTTP url in unified config`);
    }

    const discovered = await discoverMcp(mcpUrl);
    const resource = discovered.prm.resource || mcpUrl.replace(/\/+$/, "");
    const as = discovered.as;

    if (!as.code_challenge_methods_supported?.includes("S256")) {
        throw new Error(`${as.issuer} does not advertise PKCE S256`);
    }

    const policy = policyFor(options.config);
    const clientName = options.clientName?.trim() || clientNameFor(options.config);
    const pkce = await generatePkcePair();
    const listener = await startCallbackListener({
        redirectUri: "http://127.0.0.1:0/callback",
        port: 0,
        timeoutMs: 10 * 60 * 1000,
        verifyState: (state) => (state === pkce.state ? undefined : "state mismatch"),
        brand: { app: "Genesis Tools", product: "mcp-manager" },
    });

    if (!listener) {
        throw new Error("Could not bind a loopback callback port");
    }

    const redirectUri = `http://127.0.0.1:${listener.port}/callback`;
    const registered = await (async () => {
        if (policy === "static-client") {
            throw new Error(`${options.server} policy is static-client; store a client-id first`);
        }

        if (!as.registration_endpoint) {
            throw new Error(`${as.issuer} has no registration_endpoint`);
        }

        return await registerClient(as.registration_endpoint, redirectUri, clientName, {
            server: options.server,
            mcpUrl,
        });
    })();
    const clientId = registered.client_id;

    try {
        if (options.device || policy === "device-code") {
            if (!as.device_authorization_endpoint) {
                throw new Error(`${as.issuer} has no device_authorization_endpoint`);
            }

            const deviceConfig: DeviceFlowConfig = {
                clientId,
                scope: discovered.prm.scopes_supported?.join(" ") ?? "openid",
                deviceCodeUrl: as.device_authorization_endpoint,
                tokenUrl: as.token_endpoint,
            };
            const started = await startDeviceFlow(deviceConfig);
            const accessToken = await pollDeviceToken({
                config: deviceConfig,
                deviceCode: started.device_code,
                intervalSeconds: started.interval,
                expiresIn: started.expires_in,
            });
            const expiresAt = Date.now() + started.expires_in * 1000;
            await writeServerTokens(options.server, {
                accessToken,
                expiresAt,
                clientId,
                clientSecret: registered.client_secret,
            });
            await writeAuthStatus({
                server: options.server,
                issuer: as.issuer,
                resource,
                clientId,
                expiresAt,
                updatedAt: Date.now(),
            });

            return {
                resource,
                issuer: as.issuer,
                tokenEndpoint: as.token_endpoint,
                clientId,
                expiresAt,
            };
        }

        const authorize = new URL(as.authorization_endpoint);
        authorize.searchParams.set("response_type", "code");
        authorize.searchParams.set("client_id", clientId);
        authorize.searchParams.set("redirect_uri", redirectUri);
        authorize.searchParams.set("code_challenge", pkce.challenge);
        authorize.searchParams.set("code_challenge_method", "S256");
        authorize.searchParams.set("state", pkce.state);
        authorize.searchParams.set("resource", resource);

        if (discovered.prm.scopes_supported?.length) {
            authorize.searchParams.set("scope", discovered.prm.scopes_supported.join(" "));
        }

        await presentAuthorizationUrl({
            authUrl: authorize.toString(),
            provider: options.server,
            callbackHandled: true,
            interaction: {
                chooseUrlAction: async () => "open",
                readCode: async () => null,
            },
        });
        const callback = await listener.callback;

        if (!callback || "error" in callback) {
            throw new Error(callback && "error" in callback ? callback.error : "No authorization callback");
        }

        const tokens = await exchangeCode({
            tokenEndpoint: as.token_endpoint,
            code: callback.code,
            redirectUri,
            clientId,
            clientSecret: registered.client_secret,
            verifier: pkce.verifier,
            resource,
        });
        const expiresAt = Date.now() + (tokens.expires_in ?? 3600) * 1000;
        await writeServerTokens(options.server, {
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token,
            expiresAt,
            clientId,
            clientSecret: registered.client_secret,
        });
        await writeAuthStatus({
            server: options.server,
            issuer: as.issuer,
            resource,
            clientId,
            expiresAt,
            updatedAt: Date.now(),
        });

        return {
            resource,
            issuer: as.issuer,
            tokenEndpoint: as.token_endpoint,
            clientId,
            expiresAt,
        };
    } finally {
        await listener.close();
    }
}

import type { UnifiedMCPServerConfig } from "@app/mcp-manager/utils/providers/types.js";
import { startCallbackListener } from "@genesiscz/utils/ai/oauth/callback-server";
import { presentAuthorizationUrl } from "@genesiscz/utils/ai/oauth/login-ui";
import { generatePkcePair } from "@genesiscz/utils/ai/oauth/pkce";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { pollDeviceTokenResponse, startDeviceFlow } from "@genesiscz/utils/oauth/device-flow";
import type { DeviceFlowConfig } from "@genesiscz/utils/oauth/types";
import { discoverMcp } from "./discovery.ts";
import { mcpFetch, readJsonRecord } from "./fetch.ts";
import { clientNameFor, policyFor, serverAuth } from "./policy.ts";
import { type DcrFailureView, describeDcrFailure } from "./presets.ts";
import { safeTokenErrorCode } from "./redact.ts";
import { replaceServerTokens } from "./secrets.ts";
import { writeAuthStatus } from "./status.ts";

export class DynamicClientRegistrationError extends Error {
    readonly view: DcrFailureView;

    constructor(view: DcrFailureView) {
        super([view.title, ...view.detail, view.issue, ...view.retry].filter(Boolean).join("\n"));
        this.name = "DynamicClientRegistrationError";
        this.view = view;
    }
}

export interface LoginOptions {
    server: string;
    config: UnifiedMCPServerConfig;
    device?: boolean;
    yes?: boolean;
    clientName?: string;
    /**
     * Called with the URL the user has to visit, before it is presented. A caller with
     * no terminal — the gateway — uses it to put the link somewhere reachable, so a
     * banner that already faded or a window closed by accident is not a dead end.
     */
    onAuthorizationUrl?: (url: string) => void | Promise<void>;
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

    throw new DynamicClientRegistrationError(
        describeDcrFailure({
            server: hint.server,
            mcpUrl: hint.mcpUrl,
            status: lastStatus,
            body: lastBody,
            clientName,
        })
    );
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
    const { json } = await readJsonRecord(response);
    const accessToken = json?.access_token;

    if (!response.ok || typeof accessToken !== "string") {
        // The handoff's second recorded bug was a token failure that printed one guess
        // for five different causes, which cost a whole user round trip. The answer is to
        // name the cause PRECISELY, not to echo the body.
        //
        // One rule, applied in both directions:
        //
        //   Provider free text may be shown ONCE, to the person who triggered the action.
        //   It is never written to storage.
        //
        // So RFC 6749 §5.2's error_description — which exists to tell a developer what
        // went wrong — reaches the terminal of the interactive login that just failed,
        // capped, and reaches neither the day-stamped log nor auth-status.json. The log
        // gets bounded values only: the registered code, the status, and the fields of
        // the request WE sent.
        const code = safeTokenErrorCode(json?.error, response.status);
        const description =
            typeof json?.error_description === "string" ? json.error_description.slice(0, 200) : undefined;
        logger.warn(
            {
                tokenEndpoint: opts.tokenEndpoint,
                status: response.status,
                code,
                clientId: opts.clientId,
                redirectUri: opts.redirectUri,
            },
            "mcp token exchange was refused"
        );

        throw new Error(
            `Token exchange failed for client ${opts.clientId} at ${opts.tokenEndpoint} (${code})${
                description ? `: ${description}` : ""
            }`
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

    // Registration lives INSIDE the try that owns the listener. It throws on three
    // ordinary paths — a static-client policy, a server with no registration_endpoint,
    // and the Figma 403 this PR exists for — and outside the try each of those left the
    // loopback port bound for the full 10-minute timeout after the command returned.
    try {
        if (policy === "static-client") {
            throw new Error(`${options.server} policy is static-client; store a client-id first`);
        }

        if (!as.registration_endpoint) {
            throw new Error(`${as.issuer} has no registration_endpoint`);
        }

        const registered = await registerClient(as.registration_endpoint, redirectUri, clientName, {
            server: options.server,
            mcpUrl,
        });
        const clientId = registered.client_id;

        if (options.device || policy === "device-code") {
            if (!as.device_authorization_endpoint) {
                throw new Error(`${as.issuer} has no device_authorization_endpoint`);
            }

            const deviceConfig: DeviceFlowConfig = {
                clientId,
                clientSecret: registered.client_secret,
                scope: discovered.prm.scopes_supported?.join(" ") ?? "openid",
                deviceCodeUrl: as.device_authorization_endpoint,
                tokenUrl: as.token_endpoint,
            };
            const started = await startDeviceFlow(deviceConfig);
            await options.onAuthorizationUrl?.(started.verification_uri);
            // `started.expires_in` is the device_code's lifetime and only bounds the
            // poll. The access token's own lifetime comes back with the token, and
            // storing the former as the latter expired a live token within minutes.
            const granted = await pollDeviceTokenResponse({
                config: deviceConfig,
                deviceCode: started.device_code,
                intervalSeconds: started.interval,
                expiresIn: started.expires_in,
            });
            const accessToken = granted.access_token;
            const expiresAt = Date.now() + (granted.expires_in ?? 3600) * 1000;
            // Replace, never patch: this registration produced a NEW client_id, so any
            // refresh token or client_secret left over from the previous one is garbage.
            await replaceServerTokens(options.server, {
                accessToken,
                refreshToken: granted.refresh_token,
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

        await options.onAuthorizationUrl?.(authorize.toString());
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
        await replaceServerTokens(options.server, {
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

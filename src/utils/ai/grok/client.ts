import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import { decodeJwtClaims, getActiveAuthEntry, isTokenExpired, readAuthFileAsync } from "./auth";
import { GrokAuthExpiredError, isAuthHttpStatus } from "./auth-errors";
import { buildCliProxyHeaders } from "./headers";
import { GROK_CLI_CHAT_PROXY_BASE_URL, grokAuthPath } from "./paths";
import type { GrokBillingConfig, GrokProbeResult, GrokSettings } from "./types";

export interface GrokSubscriptionClientOptions {
    token: string;
    authPath?: string;
    baseUrl?: string;
    clientVersion?: string;
}

export class GrokSubscriptionClient {
    private token: string;
    private readonly authPath: string;
    private readonly baseUrl: string;
    private readonly clientVersion?: string;

    constructor(options: GrokSubscriptionClientOptions) {
        this.token = options.token;
        this.authPath = options.authPath ?? grokAuthPath();
        this.baseUrl = options.baseUrl ?? GROK_CLI_CHAT_PROXY_BASE_URL;
        this.clientVersion = options.clientVersion;
    }

    static async fromAuthFile(authPath?: string): Promise<GrokSubscriptionClient | null> {
        const entries = await readAuthFileAsync(authPath);
        const active = getActiveAuthEntry(entries);

        if (!active) {
            return null;
        }

        return new GrokSubscriptionClient({
            token: active.key,
            authPath: authPath ?? grokAuthPath(),
        });
    }

    getToken(): string {
        return this.token;
    }

    async reloadTokenFromDisk(): Promise<string | null> {
        const entries = await readAuthFileAsync(this.authPath);
        const active = getActiveAuthEntry(entries);

        if (!active) {
            return null;
        }

        this.token = active.key;
        return this.token;
    }

    assertTokenFresh(): void {
        const claims = decodeJwtClaims(this.token);

        if (isTokenExpired(claims)) {
            throw new GrokAuthExpiredError(this.authPath);
        }
    }

    private async ensureFreshTokenInMemory(): Promise<void> {
        if (!isTokenExpired(decodeJwtClaims(this.token))) {
            return;
        }

        const previousToken = this.token;
        const reloaded = await this.reloadTokenFromDisk();

        if (reloaded && reloaded !== previousToken) {
            logger.debug("grok: in-memory token expired, reloaded auth.json from disk");
        }

        if (isTokenExpired(decodeJwtClaims(this.token))) {
            throw new GrokAuthExpiredError(this.authPath);
        }
    }

    async fetch(path: string, init?: RequestInit & { modelOverride?: string }): Promise<Response> {
        await this.ensureFreshTokenInMemory();

        let response = await this.doFetch(path, init);

        if (isAuthHttpStatus(response.status)) {
            const previousToken = this.token;
            const reloaded = await this.reloadTokenFromDisk();

            if (reloaded && reloaded !== previousToken) {
                logger.debug("grok: reloaded auth.json after 401, retrying once");
                response = await this.doFetch(path, init);
            }
        }

        if (isAuthHttpStatus(response.status)) {
            // Drain the upstream body so we can include it in the diagnostic log —
            // otherwise we throw away the only clue about WHY upstream said 401.
            // The body is small (xAI auth-fail bodies are <1KB); buffering is fine here.
            let bodyExcerpt = "";
            try {
                bodyExcerpt = (await response.text()).slice(0, 500);
            } catch (err) {
                bodyExcerpt = `<failed to read body: ${err instanceof Error ? err.message : String(err)}>`;
            }

            logger.warn(
                {
                    path,
                    upstreamStatus: response.status,
                    upstreamBodyExcerpt: bodyExcerpt,
                    modelOverride: init?.modelOverride,
                    authPath: this.authPath,
                },
                "grok: upstream returned auth-status, throwing GrokAuthExpiredError"
            );

            throw new GrokAuthExpiredError(this.authPath);
        }

        return response;
    }

    private async doFetch(path: string, init?: RequestInit & { modelOverride?: string }): Promise<Response> {
        const url = `${this.baseUrl}${path}`;
        const headers = {
            ...buildCliProxyHeaders({
                token: this.token,
                modelOverride: init?.modelOverride,
                clientVersion: this.clientVersion,
            }),
            ...(init?.headers ?? {}),
        };

        const { modelOverride: _modelOverride, ...requestInit } = init ?? {};
        return fetch(url, { ...requestInit, headers });
    }

    private async ensureOk(response: Response, endpoint: string): Promise<void> {
        if (response.ok) {
            return;
        }

        throw new Error(`Grok API ${endpoint} failed: HTTP ${response.status}`);
    }

    async getModels(): Promise<unknown> {
        const response = await this.fetch("/models");
        await this.ensureOk(response, "/models");
        return response.json();
    }

    async getSettings(): Promise<GrokSettings> {
        const response = await this.fetch("/settings");
        await this.ensureOk(response, "/settings");
        return (await response.json()) as GrokSettings;
    }

    async getBilling(): Promise<GrokBillingConfig> {
        const response = await this.fetch("/billing");
        await this.ensureOk(response, "/billing");
        const payload = (await response.json()) as GrokBillingConfig | { config?: GrokBillingConfig };

        if (typeof payload === "object" && payload !== null && "config" in payload && payload.config) {
            return payload.config;
        }

        return payload as GrokBillingConfig;
    }

    async getUser(): Promise<unknown> {
        const response = await this.fetch("/user");
        await this.ensureOk(response, "/user");
        return response.json();
    }

    async probeModel(id: string): Promise<GrokProbeResult> {
        const started = performance.now();
        const body = SafeJSON.stringify({
            model: id,
            input: "ping",
            max_output_tokens: 1,
            stream: false,
        });

        const response = await this.fetch("/responses", {
            method: "POST",
            body,
            modelOverride: id,
        });

        return {
            httpCode: response.status,
            latencyMs: Math.round(performance.now() - started),
            ok: response.ok,
        };
    }
}

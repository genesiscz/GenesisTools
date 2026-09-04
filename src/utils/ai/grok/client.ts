import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { decodeJwtClaims, getActiveAuthEntry, isTokenExpired, readAuthFileAsync } from "./auth";
import { GrokAuthExpiredError, isAuthHttpStatus } from "./auth-errors";
import { buildCliProxyHeaders } from "./headers";
import { GROK_CLI_CHAT_PROXY_BASE_URL, grokAuthPath } from "./paths";
import { refreshGrokAuth, refreshGrokAuthOrThrow } from "./refresh";
import type { GrokBillingConfig, GrokCreditsConfig, GrokProbeResult, GrokSettings } from "./types";

export interface GrokSubscriptionClientOptions {
    token: string;
    authPath?: string;
    baseUrl?: string;
    clientVersion?: string;
    /**
     * This client is a DIAGNOSIS, not real use: read the credential, never rotate it.
     *
     * The OIDC grant in `~/.grok/auth.json` is single-use — `refreshGrokAuth`
     * rotates the `refresh_token` and rewrites a file the Grok CLI owns. A probe
     * that refreshed would therefore spend the user's grant on a report, which is
     * how `tools ai-proxy config detect` came to rotate a live token just by
     * printing an account's plan name.
     *
     * Same contract as `BindContext.probe` (providers/plugin-types.ts) and the
     * same guard shape as `ensureFreshToken` (grok/account.ts): refuse at the line
     * that spends the credential, and name the command that repairs it.
     */
    probe?: boolean;
}

export class GrokSubscriptionClient {
    private token: string;
    private readonly authPath: string;
    private readonly baseUrl: string;
    private readonly clientVersion?: string;
    private readonly probe: boolean;

    constructor(options: GrokSubscriptionClientOptions) {
        this.token = options.token;
        this.authPath = options.authPath ?? grokAuthPath();
        this.baseUrl = options.baseUrl ?? GROK_CLI_CHAT_PROXY_BASE_URL;
        this.clientVersion = options.clientVersion;
        this.probe = options.probe ?? false;
    }

    static async fromAuthFile(
        authPath?: string,
        options?: Pick<GrokSubscriptionClientOptions, "probe">
    ): Promise<GrokSubscriptionClient | null> {
        const entries = await readAuthFileAsync(authPath);
        const active = getActiveAuthEntry(entries);

        if (!active) {
            return null;
        }

        return new GrokSubscriptionClient({
            token: active.key,
            authPath: authPath ?? grokAuthPath(),
            ...(options?.probe === undefined ? {} : { probe: options.probe }),
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
            await this.refreshToken("expired in memory and on disk");
        }
    }

    /**
     * The ONE gate in front of every OIDC grant this client can spend.
     *
     * Both refresh paths (expired-on-open and upstream-401) ask here first, so the
     * guard sits immediately before the line that spends the credential rather
     * than at each of this client's five callers. A new caller inherits the
     * protection by passing `probe`, and a new refresh path inside the client
     * cannot forget it without also skipping this method.
     */
    private assertMayRefresh(reason: string): void {
        if (!this.probe) {
            return;
        }

        throw new Error(
            `Refusing to refresh the Grok token in ${this.authPath} during a diagnosis (${reason}): ` +
                "the OIDC grant is single-use and refreshing would rotate the Grok CLI's refresh token " +
                "and rewrite its auth file. Run: grok"
        );
    }

    /**
     * Last resort before giving up on an expired token: perform the OIDC
     * refresh-token grant ourselves instead of telling the user to run the
     * `grok` CLI, which a background daemon cannot do.
     */
    private async refreshToken(reason: string): Promise<void> {
        this.assertMayRefresh(reason);

        this.token = await refreshGrokAuthOrThrow({
            authPath: this.authPath,
            context: { reason },
            onSuccess: "grok: recovered the session with an OIDC refresh",
            onFailure: "grok: OIDC refresh did not yield a usable token",
        });
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
            } else {
                // Same token the upstream just rejected — force the grant rather
                // than retrying the identical credential. A rejected token is
                // usually still inside its `exp`, so an unforced refresh would
                // hand back that same credential and skip the retry entirely.
                this.assertMayRefresh(`upstream returned ${response.status}`);

                const refreshed = await refreshGrokAuth({ path: this.authPath, force: true });

                if (refreshed && refreshed !== previousToken) {
                    this.token = refreshed;
                    logger.info({ authPath: this.authPath }, "grok: refreshed auth after 401, retrying once");
                    response = await this.doFetch(path, init);
                }
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

    /**
     * Both billing forms answer inside a `{ config: … }` envelope, and both have been seen
     * bare. Unwrapping in one place keeps the two readers from drifting apart.
     */
    private unwrapConfig<T>(payload: T | { config?: T }): T {
        if (typeof payload === "object" && payload !== null && "config" in payload && payload.config) {
            return payload.config;
        }

        return payload as T;
    }

    async getBilling(): Promise<GrokBillingConfig> {
        const response = await this.fetch("/billing");
        await this.ensureOk(response, "/billing");
        return this.unwrapConfig((await response.json()) as GrokBillingConfig | { config?: GrokBillingConfig });
    }

    /**
     * Subscription usage, which `/billing` alone never reports: on a pure subscription every
     * figure in the plain form stays zero while this one carries the real percentage.
     */
    async getCredits(): Promise<GrokCreditsConfig> {
        const path = "/billing?format=credits";
        const response = await this.fetch(path);
        await this.ensureOk(response, path);
        return this.unwrapConfig((await response.json()) as GrokCreditsConfig | { config?: GrokCreditsConfig });
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

import { logger } from "@app/logger";
import { CopilotAuthExpiredError, isAuthHttpStatus } from "@app/utils/ai/github-copilot/auth-errors";
import { buildCopilotRequestHeaders, COPILOT_STATIC_HEADERS } from "@app/utils/ai/github-copilot/headers";
import { copilotDataDir } from "@app/utils/ai/github-copilot/paths";
import { clearSessionCache, getCopilotSession, resolveGithubCopilotGhoToken } from "@app/utils/ai/github-copilot/token";
import type { CopilotSessionCache } from "@app/utils/ai/github-copilot/types";
import { ApiClient, ApiClientError, resolveUrl } from "@app/utils/api/ApiClient";
import { SafeJSON } from "@app/utils/json";

export interface GithubCopilotApiOptions {
    dataDir?: string;
    apiBaseUrl?: string;
}

export class GithubCopilotApi extends ApiClient {
    private readonly dataDir: string;
    private sessionBaseUrl?: string;

    constructor(options: GithubCopilotApiOptions = {}) {
        super({
            baseUrl: options.apiBaseUrl,
            userAgent: COPILOT_STATIC_HEADERS["User-Agent"],
            headers: {
                ...COPILOT_STATIC_HEADERS,
            },
            loggerContext: { component: "GithubCopilotApi" },
        });

        this.dataDir = copilotDataDir(options.dataDir);
        this.sessionBaseUrl = options.apiBaseUrl;
    }

    getDataDir(): string {
        return this.dataDir;
    }

    private async loadSession(): Promise<CopilotSessionCache> {
        try {
            const session = await getCopilotSession(this.dataDir);
            this.sessionBaseUrl = session.apiBaseUrl;
            this.setHeader("Authorization", `Bearer ${session.token}`);
            return session;
        } catch {
            throw new CopilotAuthExpiredError(this.dataDir);
        }
    }

    private upstreamUrl(path: string): string {
        const base = this.sessionBaseUrl ?? "";
        return resolveUrl(base, path);
    }

    private extractMessages(bodyText?: string): unknown[] {
        if (!bodyText) {
            return [];
        }

        try {
            const parsed = SafeJSON.parse(bodyText, { strict: true }) as {
                messages?: unknown[];
                input?: unknown[];
            };
            if (Array.isArray(parsed.messages)) {
                return parsed.messages;
            }

            if (Array.isArray(parsed.input)) {
                return parsed.input;
            }
        } catch (err) {
            logger.debug({ err }, "github-copilot: extractMessages parse failed; treating as empty");
            return [];
        }

        return [];
    }

    private mergeRequestHeaders(messages: unknown[], extra?: HeadersInit): Headers {
        const headers = new Headers(extra ?? {});

        for (const [key, value] of Object.entries(buildCopilotRequestHeaders(messages))) {
            headers.set(key, value);
        }

        return headers;
    }

    async copilotGet<T>(path: string, messages: unknown[] = []): Promise<T> {
        await this.loadSession();

        const requestOptions = {
            headers: buildCopilotRequestHeaders(messages),
        };

        try {
            return await this.get<T>(this.upstreamUrl(path), requestOptions);
        } catch (error) {
            if (!(error instanceof ApiClientError) || !isAuthHttpStatus(error.status ?? 0)) {
                throw error;
            }

            const resolved = await resolveGithubCopilotGhoToken({
                dataDir: this.dataDir,
                allowKeychain: true,
            });

            if (!resolved?.token) {
                throw new CopilotAuthExpiredError(this.dataDir);
            }

            logger.debug("github-copilot: refreshing session after auth failure");
            clearSessionCache(this.dataDir);
            await this.loadSession();
            return this.get<T>(this.upstreamUrl(path), requestOptions);
        }
    }

    /**
     * Native fetch passthrough for streaming upstream responses (SSE).
     * JSON-only calls should use copilotGet / copilotPost instead.
     */
    async fetch(path: string, init: RequestInit & { bodyText?: string } = {}): Promise<Response> {
        const bodyText = typeof init.body === "string" ? init.body : init.bodyText;
        const messages = this.extractMessages(bodyText);

        let session = await this.loadSession();
        let response = await this.nativeFetch(session, path, init, messages);

        if (isAuthHttpStatus(response.status)) {
            const resolved = await resolveGithubCopilotGhoToken({
                dataDir: this.dataDir,
                allowKeychain: true,
            });

            if (resolved?.token) {
                logger.debug("github-copilot: refreshing session after auth failure");
                clearSessionCache(this.dataDir);
                session = await this.loadSession();
                response = await this.nativeFetch(session, path, init, messages);
            }
        }

        return response;
    }

    private async nativeFetch(
        session: CopilotSessionCache,
        path: string,
        init: RequestInit & { bodyText?: string },
        messages: unknown[]
    ): Promise<Response> {
        const headers = this.mergeRequestHeaders(messages, init.headers);
        headers.set("Authorization", `Bearer ${session.token}`);

        if (!headers.has("Accept")) {
            headers.set("Accept", "application/json");
        }

        if (init.body && !headers.has("Content-Type")) {
            headers.set("Content-Type", "application/json");
        }

        const { bodyText: _bodyText, ...requestInit } = init;

        return fetch(this.upstreamUrl(path), {
            ...requestInit,
            headers,
        });
    }
}

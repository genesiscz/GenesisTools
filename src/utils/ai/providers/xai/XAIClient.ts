import { logger } from "@genesiscz/utils/logger";
import { providerApiKey } from "../resolve";

const BASE_URL = "https://api.x.ai/v1";
const WS_BASE_URL = "wss://api.x.ai/v1";

export const XAI_PROVIDER_ID = "xai";

/**
 * Transport for every xAI speech call.
 *
 * The key comes from the caller, or from `providerApiKey("xai")`: the enabled xai
 * accounts first (a vault key, or the variable an account opted into), then
 * XAI_API_KEY / X_AI_API_KEY with a warning. It used to default to
 * `env.x.getApiKey()`, so a process started without the shell's exports
 * (Genesis.app, a launchd job) had no key even when an account held one.
 */
export class XAIClient {
    private readonly explicitKey?: string;
    private pending?: Promise<string>;

    constructor(apiKey?: string) {
        const trimmed = apiKey?.trim();

        if (trimmed) {
            this.explicitKey = trimmed;
        }
    }

    get baseUrl(): string {
        return BASE_URL;
    }

    get wsBaseUrl(): string {
        return WS_BASE_URL;
    }

    /**
     * The lookup is memoised, but a REJECTED lookup is not: a caller that adds an
     * account mid-process would otherwise keep being told there is no key by a
     * promise that failed once.
     */
    async requireKey(): Promise<string> {
        if (this.explicitKey) {
            return this.explicitKey;
        }

        if (!this.pending) {
            this.pending = providerApiKey(XAI_PROVIDER_ID).catch((err: unknown) => {
                this.pending = undefined;
                throw err;
            });
        }

        return this.pending;
    }

    async isConfigured(): Promise<boolean> {
        try {
            await this.requireKey();
            return true;
        } catch (err) {
            logger.debug({ err }, "xai has no usable credential");
            return false;
        }
    }

    async fetch(path: string, init?: RequestInit): Promise<Response> {
        const apiKey = await this.requireKey();
        const url = `${BASE_URL}${path}`;
        const headers = { ...authHeader(apiKey), ...(init?.headers ?? {}) };
        return fetch(url, { ...init, headers });
    }

    async openWebSocket(path: string, params: URLSearchParams): Promise<WebSocket> {
        const apiKey = await this.requireKey();
        const url = `${WS_BASE_URL}${path}?${params.toString()}`;
        return new WebSocket(url, { headers: authHeader(apiKey) } as never);
    }
}

function authHeader(apiKey: string): { Authorization: string } {
    return { Authorization: `Bearer ${apiKey}` };
}

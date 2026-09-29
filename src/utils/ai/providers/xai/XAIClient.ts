import { logger } from "@genesiscz/utils/logger";
import { openHeaderWebSocket } from "@genesiscz/utils/net/header-websocket";
import { providerApiKey } from "../resolve";

const BASE_URL = "https://api.x.ai/v1";
const WS_BASE_URL = "wss://api.x.ai/v1";

export const XAI_PROVIDER_ID = "xai";

/** How long a resolved key is reused before the account is read again. */
const KEY_TTL_MS = 60_000;

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
    private pendingAt = 0;
    private readonly lookup: () => Promise<string>;
    private readonly now: () => number;

    /** `deps` is for tests: the account lookup and the clock. */
    constructor(apiKey?: string, deps: { lookup?: () => Promise<string>; now?: () => number } = {}) {
        this.lookup = deps.lookup ?? (() => providerApiKey(XAI_PROVIDER_ID));
        this.now = deps.now ?? Date.now;
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
     * The lookup is shared by concurrent callers and kept for KEY_TTL_MS, but a
     * REJECTED lookup is not kept: a caller that adds an account mid-process would
     * otherwise keep being told there is no key by a promise that failed once. The
     * lifetime matters the other way too: a long-running `say` kept sending a key
     * that had since been rotated.
     */
    async requireKey(): Promise<string> {
        if (this.explicitKey) {
            return this.explicitKey;
        }

        if (!this.pending || this.now() - this.pendingAt > KEY_TTL_MS) {
            this.pendingAt = this.now();
            const lookup: Promise<string> = this.lookup().catch((err: unknown) => {
                // An expired lookup that fails late must not drop the one that replaced it.
                if (this.pending === lookup) {
                    this.pending = undefined;
                }

                throw err;
            });
            this.pending = lookup;
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
        return openHeaderWebSocket(url, authHeader(apiKey));
    }
}

function authHeader(apiKey: string): { Authorization: string } {
    return { Authorization: `Bearer ${apiKey}` };
}

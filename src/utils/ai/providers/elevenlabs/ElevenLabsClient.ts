import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import { providerApiKey } from "../resolve";

const prof = profiler.scope("tts");

/**
 * The global ElevenLabs host. Regional hosts exist (`api.us.`, `api.eu.residency.`,
 * …) and differ only in this prefix, so they are one constant away should a
 * residency requirement ever arrive.
 */
const BASE_URL = "https://api.elevenlabs.io";
const WS_BASE_URL = "wss://api.elevenlabs.io";

export const ELEVENLABS_PROVIDER_ID = "elevenlabs";

/**
 * Transport for every ElevenLabs call: REST over `xi-api-key`, WebSocket over the
 * same header.
 *
 * ⚠️ It never reads the environment. `XAIClient` defaults its key to
 * `env.x.getApiKey()`, which is the pattern that made a key arrive with no
 * account behind it — invisible in `tools ai config account list`, impossible to
 * disable or attribute. Here the key either comes from the caller (the plugin
 * binding already resolved the account's credential) or from
 * `providerApiKey("elevenlabs")`, which tries configured accounts first and only
 * then the variable the plugin declares, with a warning.
 */
export class ElevenLabsClient {
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
     * account mid-process (`tools ai config account add`) would otherwise keep
     * being told there is no key by a promise that failed once.
     */
    async requireKey(): Promise<string> {
        if (this.explicitKey) {
            return this.explicitKey;
        }

        if (!this.pending) {
            this.pending = providerApiKey(ELEVENLABS_PROVIDER_ID).catch((err: unknown) => {
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
            logger.debug({ err }, "elevenlabs has no usable credential");
            return false;
        }
    }

    async fetch(path: string, init?: RequestInit): Promise<Response> {
        const apiKey = await this.requireKey();
        // `new Headers(...)` rather than an object spread: `init.headers` may be a
        // `Headers` instance, and spreading one yields `{}` — the auth header would
        // survive and every caller-supplied header would silently vanish.
        const headers = new Headers(init?.headers);
        headers.set("xi-api-key", apiKey);
        const method = init?.method ?? "GET";
        logger.debug({ provider: ELEVENLABS_PROVIDER_ID, method, path: path.split("?")[0] }, "elevenlabs request");
        const response = await prof.measureAsync(`elevenlabs ${method} ${path.split("?")[0]}`, () =>
            fetch(`${BASE_URL}${path}`, { ...init, headers })
        );
        logger.debug({ provider: ELEVENLABS_PROVIDER_ID, method, status: response.status }, "elevenlabs response");
        return response;
    }

    async openWebSocket(path: string, params: URLSearchParams): Promise<WebSocket> {
        const apiKey = await this.requireKey();
        const url = `${WS_BASE_URL}${path}?${params.toString()}`;

        // Bun's WebSocket accepts a `headers` option the DOM lib does not declare.
        return new WebSocket(url, { headers: { "xi-api-key": apiKey } } as never);
    }
}

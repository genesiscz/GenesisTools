const BASE_URL = "https://api.x.ai/v1";
const WS_BASE_URL = "wss://api.x.ai/v1";

export class XAIClient {
    constructor(private readonly apiKey: string = process.env.X_AI_API_KEY ?? "") {}

    isConfigured(): boolean {
        return !!this.apiKey;
    }

    requireKey(): void {
        if (!this.apiKey) {
            throw new Error(
                "X_AI_API_KEY environment variable is not set. Get a key at https://console.x.ai/team/default/api-keys"
            );
        }
    }

    get baseUrl(): string {
        return BASE_URL;
    }

    get wsBaseUrl(): string {
        return WS_BASE_URL;
    }

    authHeader(): { Authorization: string } {
        return { Authorization: `Bearer ${this.apiKey}` };
    }

    async fetch(path: string, init?: RequestInit): Promise<Response> {
        this.requireKey();
        const url = `${BASE_URL}${path}`;
        const headers = { ...this.authHeader(), ...(init?.headers ?? {}) };
        return fetch(url, { ...init, headers });
    }

    openWebSocket(path: string, params: URLSearchParams): WebSocket {
        this.requireKey();
        const url = `${WS_BASE_URL}${path}?${params.toString()}`;
        return new WebSocket(url, { headers: this.authHeader() } as never);
    }
}

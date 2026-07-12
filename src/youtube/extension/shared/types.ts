export interface ExtensionConfig {
    apiBaseUrl: string;
    /**
     * Per-user service key for an authed (VPS) server. Sent as
     * `Authorization: Bearer` on API fetches and as `?access_token=` on the
     * events WebSocket. Empty/undefined for an open localhost server.
     */
    serviceKey?: string;
}

export interface ExtensionConfig {
    apiBaseUrl: string;
    /**
     * Per-user service key for an authed (VPS) server. Sent as
     * `Authorization: Bearer` on API fetches and as `?access_token=` on the
     * events WebSocket. Empty/undefined for an open localhost server.
     */
    serviceKey?: string;
    /**
     * Per-user API token (`ytu_…`) from register/login. Sent as
     * `Authorization: Bearer` on API fetches; takes precedence over
     * `serviceKey`. Cleared locally on logout.
     */
    userToken?: string;
}

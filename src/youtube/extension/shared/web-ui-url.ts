/**
 * YouTube web UI port — keep in sync with `DASHBOARDS.youtube.port`
 * in `src/utils/ui/dashboards.ts` (3074). The API server (9876) does not
 * serve the SPA, so "Open in GenesisTools" must target this UI, not apiBaseUrl.
 */
export const YOUTUBE_WEB_UI_PORT = 3074;

/** Resolve the GenesisTools YouTube web UI origin from the extension's API base. */
export function youtubeWebUiBaseUrl(apiBaseUrl: string): string {
    try {
        const api = new URL(apiBaseUrl);

        if (api.hostname === "localhost" || api.hostname === "127.0.0.1") {
            return `${api.protocol}//${api.hostname}:${YOUTUBE_WEB_UI_PORT}`;
        }

        // Remote: same host/path prefix as the API (operators who only expose
        // the JSON API still get a broken link — local is the common case).
        return `${api.origin}${api.pathname.replace(/\/$/, "")}`;
    } catch {
        return "";
    }
}

export function youtubeChannelWebUrl(apiBaseUrl: string, handle: string): string {
    const base = youtubeWebUiBaseUrl(apiBaseUrl).replace(/\/$/, "");

    if (!base) {
        return "";
    }

    return `${base}/channels/${encodeURIComponent(handle)}`;
}

/**
 * Top-level segments the proxy serves under its base path (`server.ts` dispatches
 * `/health` and `/v1/...`, nothing else). The tunnel ingress rule names exactly these,
 * so any other `/<base>/...` path (the dev-dashboard's `/ai/accounts` page) stays on
 * the hostname's catch-all service.
 */
export const AI_PROXY_PUBLIC_SEGMENTS = ["v1", "health"] as const;

export function normalizeBasePath(basePath?: string): string {
    if (!basePath) {
        return "";
    }

    const trimmed = basePath.trim();
    if (!trimmed || trimmed === "/") {
        return "";
    }

    const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
    return withSlash.replace(/\/+$/, "");
}

export function stripBasePath(pathname: string, basePath?: string): string {
    const prefix = normalizeBasePath(basePath);

    if (!prefix) {
        return pathname;
    }

    if (pathname === prefix) {
        return "/";
    }

    if (pathname.startsWith(`${prefix}/`)) {
        const stripped = pathname.slice(prefix.length);
        return stripped || "/";
    }

    return pathname;
}

import { SafeJSON } from "@app/utils/json";
import type { YoutubeConfigPatch } from "@app/youtube/lib/config.api.types";
import type { YoutubeConfigShape } from "@app/youtube/lib/types";

export interface UiConfigResponse {
    config: YoutubeConfigShape;
    where: string;
}

export interface UiConfigPatchResponse {
    config: YoutubeConfigShape;
}

const FALLBACK_API_BASE_URL = "http://localhost:9876";
const DEV_CONFIG_PATH = "/__config";
const API_CONFIG_PATH = "/api/v1/config";

/**
 * Resolved at first call: the URL prefix the rest of the UI should use to hit the
 * API server. In Vite dev that's `/__config` (a Vite middleware shim). In a
 * production build (no Vite middleware), the UI tries the same origin first and
 * falls back to `http://localhost:9876` so it Just Works for the local-daemon use
 * case described in the README.
 */
let resolvedApiPrefix: string | null = null;

export function clearResolvedApiPrefix(): void {
    resolvedApiPrefix = null;
}

export async function fetchUiConfig(): Promise<UiConfigResponse> {
    if (resolvedApiPrefix === DEV_CONFIG_PATH) {
        const res = await fetch(DEV_CONFIG_PATH);

        if (res.ok) {
            return (await res.json()) as UiConfigResponse;
        }
    }

    if (resolvedApiPrefix && resolvedApiPrefix !== DEV_CONFIG_PATH) {
        const res = await fetch(`${resolvedApiPrefix}${API_CONFIG_PATH}`);

        if (res.ok) {
            const json = (await res.json()) as UiConfigResponse;
            return ensureApiBaseUrl(json, resolvedApiPrefix);
        }
    }

    const dev = await tryFetchDevConfig();

    if (dev) {
        resolvedApiPrefix = DEV_CONFIG_PATH;
        return dev;
    }

    for (const base of productionApiCandidates()) {
        const json = await tryFetchApiConfig(base);

        if (json) {
            resolvedApiPrefix = base;
            return ensureApiBaseUrl(json, base);
        }
    }

    throw new Error("failed to load config from /__config or /api/v1/config");
}

export async function patchUiConfig(patch: YoutubeConfigPatch): Promise<UiConfigPatchResponse> {
    if (!resolvedApiPrefix) {
        await fetchUiConfig();
    }

    const isDev = resolvedApiPrefix === DEV_CONFIG_PATH;
    const url = isDev ? DEV_CONFIG_PATH : `${resolvedApiPrefix}${API_CONFIG_PATH}`;
    const res = await fetch(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: SafeJSON.stringify(patch),
    });

    if (!res.ok) {
        const body = await res.text();
        throw new Error(`failed to patch config: ${res.status} ${body}`.trim());
    }

    return (await res.json()) as UiConfigPatchResponse;
}

async function tryFetchDevConfig(): Promise<UiConfigResponse | null> {
    try {
        const res = await fetch(DEV_CONFIG_PATH);

        if (res.ok) {
            return (await res.json()) as UiConfigResponse;
        }
    } catch {
        // network error or 404 — fall through to production paths
    }

    return null;
}

async function tryFetchApiConfig(base: string): Promise<UiConfigResponse | null> {
    try {
        const res = await fetch(`${base}${API_CONFIG_PATH}`);

        if (res.ok) {
            return (await res.json()) as UiConfigResponse;
        }
    } catch {
        // continue to next candidate
    }

    return null;
}

function productionApiCandidates(): string[] {
    const out: string[] = [];

    if (typeof window !== "undefined" && window.location && window.location.origin) {
        out.push(window.location.origin);
    }

    if (!out.includes(FALLBACK_API_BASE_URL)) {
        out.push(FALLBACK_API_BASE_URL);
    }

    return out;
}

function ensureApiBaseUrl(response: UiConfigResponse, base: string): UiConfigResponse {
    if (response.config.apiBaseUrl) {
        return response;
    }

    return { ...response, config: { ...response.config, apiBaseUrl: base } };
}

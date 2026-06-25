import { join } from "node:path";
import { normalizeBasePath } from "@app/ai-proxy/lib/path-prefix";
import type { AiProxyConfig, AiProxyPublicConfig } from "@app/ai-proxy/lib/types";
import { cloudflaredHome } from "@app/dev-dashboard/lib/tunnel/cloudflared";

export function resolveCloudflaredConfigPath(publicConfig?: AiProxyPublicConfig): string {
    const configured = publicConfig?.cloudflared?.configPath ?? publicConfig?.cloudflaredConfigPath;
    if (configured) {
        return configured;
    }

    return join(cloudflaredHome(), "config.yml");
}

export function resolveTunnelName(publicConfig?: AiProxyPublicConfig): string | undefined {
    return publicConfig?.cloudflared?.tunnelName ?? publicConfig?.tunnelName;
}

export function isPublicExposureEnabled(publicConfig?: AiProxyPublicConfig): boolean {
    const mode = publicConfig?.mode ?? "none";
    return mode !== "none";
}

export function buildPublicOrigin(publicConfig?: AiProxyPublicConfig): string | null {
    if (publicConfig?.mode === "custom" && publicConfig.baseUrl) {
        const trimmed = publicConfig.baseUrl.replace(/\/v1\/?$/, "");
        return trimmed || null;
    }

    const hostname = publicConfig?.hostname?.trim() ?? publicConfig?.tailscale?.hostname?.trim();
    if (!hostname) {
        return null;
    }

    const scheme = publicConfig?.mode === "tailscale" ? "http" : "https";
    return `${scheme}://${hostname}`;
}

function normalizeCustomPublicBaseUrl(baseUrl: string): string {
    const trimmed = baseUrl.trim().replace(/\/$/, "");
    return trimmed.endsWith("/v1") ? trimmed.slice(0, -3) : trimmed;
}

export function buildPublicHealthUrl(config: AiProxyConfig): string | null {
    if (config.public?.mode === "custom" && config.public.baseUrl) {
        return `${normalizeCustomPublicBaseUrl(config.public.baseUrl)}/health`;
    }

    const origin = buildPublicOrigin(config.public);
    if (!origin) {
        return null;
    }

    const basePath = normalizeBasePath(config.public?.basePath);
    return `${origin}${basePath}/health`;
}

export function buildPublicBaseUrl(config: AiProxyConfig): string | null {
    if (config.public?.mode === "custom" && config.public.baseUrl) {
        const url = config.public.baseUrl.trim();
        return url.endsWith("/v1") ? url : `${url.replace(/\/$/, "")}/v1`;
    }

    const origin = buildPublicOrigin(config.public);
    if (!origin) {
        return null;
    }

    const basePath = normalizeBasePath(config.public?.basePath);
    return `${origin}${basePath}/v1`;
}

export function buildLocalBaseUrl(config: AiProxyConfig): string {
    return `http://${config.listen.host}:${config.listen.port}/v1`;
}

export function resolveCursorBaseUrl(config: AiProxyConfig): string {
    if (isPublicExposureEnabled(config.public)) {
        return buildPublicBaseUrl(config) ?? buildLocalBaseUrl(config);
    }

    return buildLocalBaseUrl(config);
}

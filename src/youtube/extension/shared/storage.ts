import type { ExtensionConfig } from "@ext/shared/types";

const DEFAULT_CONFIG: ExtensionConfig = { apiBaseUrl: "http://localhost:9876" };

export async function getExtensionConfig(): Promise<ExtensionConfig> {
    const stored = await chrome.storage.local.get("apiBaseUrl");
    return { apiBaseUrl: typeof stored.apiBaseUrl === "string" ? stored.apiBaseUrl : DEFAULT_CONFIG.apiBaseUrl };
}

export async function setExtensionConfig(patch: Partial<ExtensionConfig>): Promise<ExtensionConfig> {
    const current = await getExtensionConfig();
    const next = { ...current, ...patch };
    await chrome.storage.local.set(next);
    return next;
}

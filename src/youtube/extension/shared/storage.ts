import type { ExtensionConfig } from "@ext/shared/types";

const DEFAULT_CONFIG: ExtensionConfig = { apiBaseUrl: "http://localhost:9876" };

export async function getExtensionConfig(): Promise<ExtensionConfig> {
    const stored = await chrome.storage.local.get(["apiBaseUrl", "serviceKey"]);
    return {
        apiBaseUrl: typeof stored.apiBaseUrl === "string" ? stored.apiBaseUrl : DEFAULT_CONFIG.apiBaseUrl,
        serviceKey:
            typeof stored.serviceKey === "string" && stored.serviceKey.length > 0 ? stored.serviceKey : undefined,
    };
}

export async function setExtensionConfig(patch: Partial<ExtensionConfig>): Promise<ExtensionConfig> {
    const current = await getExtensionConfig();
    const next: ExtensionConfig = { ...current, ...patch };

    await chrome.storage.local.set({ apiBaseUrl: next.apiBaseUrl });

    if (next.serviceKey) {
        await chrome.storage.local.set({ serviceKey: next.serviceKey });
    } else {
        await chrome.storage.local.remove("serviceKey");
    }

    return next;
}

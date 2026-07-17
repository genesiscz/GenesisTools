import type { ExtensionConfig } from "@ext/shared/types";

const DEFAULT_CONFIG: ExtensionConfig = { apiBaseUrl: "http://localhost:9876" };

export async function getExtensionConfig(): Promise<ExtensionConfig> {
    const stored = await chrome.storage.local.get(["apiBaseUrl", "serviceKey", "userToken"]);
    return {
        apiBaseUrl: typeof stored.apiBaseUrl === "string" ? stored.apiBaseUrl : DEFAULT_CONFIG.apiBaseUrl,
        serviceKey:
            typeof stored.serviceKey === "string" && stored.serviceKey.length > 0 ? stored.serviceKey : undefined,
        userToken: typeof stored.userToken === "string" && stored.userToken.length > 0 ? stored.userToken : undefined,
    };
}

export async function setExtensionConfig(patch: Partial<ExtensionConfig>): Promise<ExtensionConfig> {
    // Write only the keys present in `patch` so concurrent writers (e.g. a
    // `config:set` racing a logout) can't read-merge-clobber each other's
    // unrelated fields. chrome.storage.local.set is a partial merge.
    if (patch.apiBaseUrl !== undefined) {
        await chrome.storage.local.set({ apiBaseUrl: patch.apiBaseUrl });
    }

    if ("serviceKey" in patch) {
        if (patch.serviceKey) {
            await chrome.storage.local.set({ serviceKey: patch.serviceKey });
        } else {
            await chrome.storage.local.remove("serviceKey");
        }
    }

    if ("userToken" in patch) {
        if (patch.userToken) {
            await chrome.storage.local.set({ userToken: patch.userToken });
        } else {
            await chrome.storage.local.remove("userToken");
        }
    }

    return getExtensionConfig();
}

import type { ExtensionConfig } from "@ext/shared/types";
import { WEB_SERVICES } from "@genesiscz/utils/ui/dashboards";

export const DEFAULT_API_BASE_URL = `http://localhost:${WEB_SERVICES["youtube-server"].port}`;

const DEFAULT_CONFIG: ExtensionConfig = { apiBaseUrl: DEFAULT_API_BASE_URL };

/**
 * The server's first default (9876) is Blender MCP's port, so the server moved. A saved URL that is
 * exactly that old default was never a choice, so it reads as the new default; any other URL stays.
 */
const LEGACY_DEFAULT = /^http:\/\/(localhost|127\.0\.0\.1):9876\/?$/;

function storedBaseUrl(value: unknown): string {
    return typeof value === "string" && !LEGACY_DEFAULT.test(value) ? value : DEFAULT_CONFIG.apiBaseUrl;
}

export async function getExtensionConfig(): Promise<ExtensionConfig> {
    const stored = await chrome.storage.local.get(["apiBaseUrl", "serviceKey", "userToken"]);
    return {
        apiBaseUrl: storedBaseUrl(stored.apiBaseUrl),
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

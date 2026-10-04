import { describe, expect, it } from "bun:test";
import { getExtensionConfig, setExtensionConfig } from "@ext/shared/storage";
import { WEB_SERVICES } from "@genesiscz/utils/ui/dashboards";
import manifest from "../manifest.json";

function installStorage(initial: Record<string, unknown> = {}): Record<string, unknown> {
    const store = { ...initial };
    globalThis.chrome = {
        storage: {
            local: {
                get: async (keys: string | string[]) => {
                    const list = Array.isArray(keys) ? keys : [keys];
                    const result: Record<string, unknown> = {};
                    for (const key of list) {
                        result[key] = store[key];
                    }
                    return result;
                },
                set: async (items: Record<string, unknown>) => {
                    Object.assign(store, items);
                },
                remove: async (keys: string | string[]) => {
                    const list = Array.isArray(keys) ? keys : [keys];
                    for (const key of list) {
                        delete store[key];
                    }
                },
            },
        },
    } as unknown as typeof chrome;
    return store;
}

describe("extension storage", () => {
    it("defaults to localhost API with no service key", async () => {
        installStorage();

        await expect(getExtensionConfig()).resolves.toEqual({
            apiBaseUrl: "http://localhost:9886",
            serviceKey: undefined,
        });
    });

    it("reads a saved old default (9876, Blender MCP's port) as the new default, keeps any other URL", async () => {
        installStorage({ apiBaseUrl: "http://localhost:9876" });
        expect((await getExtensionConfig()).apiBaseUrl).toBe("http://localhost:9886");

        installStorage({ apiBaseUrl: "http://192.168.1.5:9876" });
        expect((await getExtensionConfig()).apiBaseUrl).toBe("http://192.168.1.5:9876");
    });

    it("asks the browser for access to the server's registry port", () => {
        expect(manifest.host_permissions).toContain(`http://localhost:${WEB_SERVICES["youtube-server"].port}/*`);
    });

    it("persists partial config patches", async () => {
        const store = installStorage({ apiBaseUrl: "http://localhost:1234" });

        await expect(setExtensionConfig({ apiBaseUrl: "http://localhost:9999" })).resolves.toEqual({
            apiBaseUrl: "http://localhost:9999",
            serviceKey: undefined,
        });
        expect(store.apiBaseUrl).toBe("http://localhost:9999");
    });

    it("persists and reads back a service key", async () => {
        const store = installStorage({ apiBaseUrl: "https://vps.example.com/yt" });

        await setExtensionConfig({ apiBaseUrl: "https://vps.example.com/yt", serviceKey: "alice-key" });

        expect(store.serviceKey).toBe("alice-key");
        await expect(getExtensionConfig()).resolves.toEqual({
            apiBaseUrl: "https://vps.example.com/yt",
            serviceKey: "alice-key",
        });
    });

    it("clears the stored key when the service key is emptied", async () => {
        const store = installStorage({ apiBaseUrl: "https://vps.example.com/yt", serviceKey: "alice-key" });

        await setExtensionConfig({ apiBaseUrl: "https://vps.example.com/yt", serviceKey: undefined });

        expect("serviceKey" in store).toBe(false);
        await expect(getExtensionConfig()).resolves.toEqual({
            apiBaseUrl: "https://vps.example.com/yt",
            serviceKey: undefined,
        });
    });

    it("coerces a blank stored key to undefined", async () => {
        installStorage({ apiBaseUrl: "http://localhost:9876", serviceKey: "" });

        await expect(getExtensionConfig()).resolves.toEqual({
            apiBaseUrl: "http://localhost:9886",
            serviceKey: undefined,
        });
    });
});

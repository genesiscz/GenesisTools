import { describe, expect, it } from "bun:test";
import { getExtensionConfig, setExtensionConfig } from "@ext/shared/storage";

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
            apiBaseUrl: "http://localhost:9876",
            serviceKey: undefined,
        });
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
            apiBaseUrl: "http://localhost:9876",
            serviceKey: undefined,
        });
    });
});

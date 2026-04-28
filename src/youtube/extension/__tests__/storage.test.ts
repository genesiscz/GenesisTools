import { describe, expect, it } from "bun:test";
import { getExtensionConfig, setExtensionConfig } from "@ext/shared/storage";

function installStorage(initial: Record<string, unknown> = {}): Record<string, unknown> {
    const store = { ...initial };
    globalThis.chrome = {
        storage: {
            local: {
                get: async (key: string) => ({ [key]: store[key] }),
                set: async (items: Record<string, unknown>) => {
                    Object.assign(store, items);
                },
            },
        },
    } as unknown as typeof chrome;
    return store;
}

describe("extension storage", () => {
    it("defaults to localhost API", async () => {
        installStorage();

        await expect(getExtensionConfig()).resolves.toEqual({ apiBaseUrl: "http://localhost:9876" });
    });

    it("persists partial config patches", async () => {
        const store = installStorage({ apiBaseUrl: "http://localhost:1234" });

        await expect(setExtensionConfig({ apiBaseUrl: "http://localhost:9999" })).resolves.toEqual({
            apiBaseUrl: "http://localhost:9999",
        });
        expect(store.apiBaseUrl).toBe("http://localhost:9999");
    });
});

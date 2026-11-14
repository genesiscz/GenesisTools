import { beforeEach, describe, expect, it, mock } from "bun:test";

// Stub the native `expo-sqlite/kv-store` module with an in-memory Map so the prefs
// round-trip can be exercised without a simulator / native runtime.
const store = new Map<string, string>();

mock.module("expo-sqlite/kv-store", () => ({
    default: {
        getItem: async (key: string): Promise<string | null> => (store.has(key) ? (store.get(key) as string) : null),
        setItem: async (key: string, value: string): Promise<void> => {
            store.set(key, value);
        },
        removeItem: async (key: string): Promise<void> => {
            store.delete(key);
        },
    },
}));

const secure = new Map<string, string>();

mock.module("expo-secure-store", () => ({
    getItemAsync: async (key: string): Promise<string | null> => secure.get(key) ?? null,
    setItemAsync: async (key: string, value: string): Promise<void> => {
        secure.set(key, value);
    },
    deleteItemAsync: async (key: string): Promise<void> => {
        secure.delete(key);
    },
}));

const { getPref, removePref, setPref } = await import("@/lib/storage/kv");
const { loadBasicCreds, saveBasicCreds } = await import("@/lib/storage/secure");

describe("kv prefs round-trip", () => {
    beforeEach(() => {
        store.clear();
    });

    it("returns null for an unset key", async () => {
        expect(await getPref("dd.theme")).toBeNull();
    });

    it("round-trips a typed enum value", async () => {
        await setPref("dd.theme", "dark");
        expect(await getPref("dd.theme")).toBe("dark");
    });

    it("round-trips a typed terminal driver id", async () => {
        await setPref("dd.terminalDriver", "webview-html");
        expect(await getPref("dd.terminalDriver")).toBe("webview-html");
    });

    it("removes a key", async () => {
        await setPref("dd.lastSessionId", "sess-42");
        expect(await getPref("dd.lastSessionId")).toBe("sess-42");
        await removePref("dd.lastSessionId");
        expect(await getPref("dd.lastSessionId")).toBeNull();
    });
});

describe("the saved basic-auth login", () => {
    beforeEach(() => {
        secure.clear();
    });

    it("round-trips a login", async () => {
        await saveBasicCreds({ username: "work", password: "pw" });
        expect(await loadBasicCreds()).toEqual({ username: "work", password: "pw" });
    });

    it("reads a corrupt or misshapen stored value as no login instead of throwing", async () => {
        secure.set("dd.basicAuth", "{not json");
        expect(await loadBasicCreds()).toBeNull();
        secure.set("dd.basicAuth", '{"username":"work"}');
        expect(await loadBasicCreds()).toBeNull();
    });
});

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getUiLang, loadUiLang, persistUiLang, setUiLang, t } from "@ext/shared/i18n";

const hadChrome = "chrome" in globalThis;
const originalChrome = globalThis.chrome;

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

beforeEach(() => {
    setUiLang("en");
});

afterEach(() => {
    if (hadChrome) {
        globalThis.chrome = originalChrome;
    } else {
        delete (globalThis as { chrome?: typeof chrome }).chrome;
    }
});

describe("i18n", () => {
    it("looks up the active language, falling back to English for unknown keys", () => {
        expect(t("tab.summary")).toBe("Summary");
        setUiLang("cs");
        expect(t("tab.summary")).toBe("Shrnutí");
    });

    it("falls back to 'en' for an unknown lang code", () => {
        setUiLang("cs");
        setUiLang("de");
        expect(getUiLang()).toBe("en");
    });

    it("persistUiLang writes the lang to chrome.storage.local under 'uiLang'", async () => {
        const store = installStorage();

        await persistUiLang("cs");

        expect(store.uiLang).toBe("cs");
        expect(getUiLang()).toBe("cs");
    });

    it("loadUiLang restores a persisted lang from storage", async () => {
        installStorage({ uiLang: "cs" });

        await loadUiLang();

        expect(getUiLang()).toBe("cs");
        expect(t("tab.ask")).toBe("Dotaz");
    });

    it("loadUiLang leaves the current lang untouched when storage has no valid value", async () => {
        installStorage({ uiLang: "zz" });

        await loadUiLang();

        expect(getUiLang()).toBe("en");
    });
});

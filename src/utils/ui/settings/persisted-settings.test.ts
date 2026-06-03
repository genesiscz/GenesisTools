import { describe, expect, it } from "bun:test";
import { loadPersistedSettings, savePersistedSettings } from "./persisted-settings";
import { createPersistedSettingsStorage } from "./persisted-settings-store";

interface SampleSettings {
    count: number;
    enabled: boolean;
}

const defaults: SampleSettings = { count: 1, enabled: true };

function parseSample(raw: unknown): SampleSettings {
    const parsed = raw as Partial<SampleSettings>;

    return {
        count: typeof parsed.count === "number" ? parsed.count : defaults.count,
        enabled: parsed.enabled !== false,
    };
}

describe("persisted settings", () => {
    it("round-trips through memory store", () => {
        const storage = createPersistedSettingsStorage("memory");
        const options = {
            storageKey: "test.settings",
            defaults,
            parse: parseSample,
            storage,
        };

        savePersistedSettings(options, { count: 9, enabled: false });
        const loaded = loadPersistedSettings(options);

        expect(loaded).toEqual({ count: 9, enabled: false });
    });

    it("returns defaults when parse throws", () => {
        const storage = createPersistedSettingsStorage("memory");
        storage.write("bad.settings", "{not json");

        const loaded = loadPersistedSettings({
            storageKey: "bad.settings",
            defaults,
            parse: parseSample,
            storage,
        });

        expect(loaded).toEqual(defaults);
    });
});

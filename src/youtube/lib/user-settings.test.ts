import { describe, expect, it } from "bun:test";
import {
    DEFAULT_USER_SETTINGS,
    mergeUserSettings,
    resolveUserSettings,
    type UserSettings,
    validateSettingsPatch,
} from "@app/youtube/lib/user-settings";

describe("resolveUserSettings", () => {
    it("fills defaults for empty/null input", () => {
        expect(resolveUserSettings(null)).toEqual({
            theme: "system",
            density: "comfortable",
            accent: undefined,
            taskDefaults: {},
            panel: {},
        });
    });

    it("keeps stored values over defaults", () => {
        const resolved = resolveUserSettings({ theme: "dark", taskDefaults: { summary: { tone: "funny" } } });

        expect(resolved.theme).toBe("dark");
        expect(resolved.density).toBe("comfortable");
        expect(resolved.taskDefaults?.summary?.tone).toBe("funny");
    });
});

describe("validateSettingsPatch", () => {
    it("accepts a well-formed patch across every section", () => {
        const res = validateSettingsPatch({
            theme: "light",
            density: "compact",
            accent: "#ff0000",
            taskDefaults: {
                summary: { tone: "actionable", length: "detailed", format: "qa", lang: "en" },
                ask: { lang: "es" },
            },
            panel: { autoOpen: true, defaultTab: "summary", rememberCollapse: false },
        });

        expect(res.ok).toBe(true);

        if (res.ok) {
            expect(res.value.taskDefaults?.summary?.format).toBe("qa");
            expect(res.value.panel?.autoOpen).toBe(true);
        }
    });

    it("rejects unknown top-level keys", () => {
        const res = validateSettingsPatch({ bogus: 1 });

        expect(res.ok).toBe(false);
    });

    it("rejects bad enum values", () => {
        expect(validateSettingsPatch({ theme: "neon" }).ok).toBe(false);
        expect(validateSettingsPatch({ density: "roomy" }).ok).toBe(false);
        expect(validateSettingsPatch({ taskDefaults: { summary: { tone: "angry" } } }).ok).toBe(false);
        expect(validateSettingsPatch({ taskDefaults: { summary: { length: "epic" } } }).ok).toBe(false);
        expect(validateSettingsPatch({ taskDefaults: { summary: { format: "table" } } }).ok).toBe(false);
    });

    it("rejects unknown task kinds and nested keys", () => {
        expect(validateSettingsPatch({ taskDefaults: { bogusKind: {} } }).ok).toBe(false);
        expect(validateSettingsPatch({ taskDefaults: { summary: { bogus: 1 } } }).ok).toBe(false);
        expect(validateSettingsPatch({ panel: { bogus: 1 } }).ok).toBe(false);
    });

    it("rejects a bad lang and wrong-typed panel booleans", () => {
        expect(validateSettingsPatch({ taskDefaults: { summary: { lang: "zzz" } } }).ok).toBe(false);
        expect(validateSettingsPatch({ panel: { autoOpen: "yes" } }).ok).toBe(false);
    });
});

describe("mergeUserSettings", () => {
    it("deep-merges per section: scalars replace, taskDefaults per-kind, panel per-key", () => {
        const current: UserSettings = {
            theme: "system",
            density: "comfortable",
            taskDefaults: { summary: { tone: "insightful", length: "auto" }, ask: { lang: "en" } },
            panel: { autoOpen: false, defaultTab: "summary" },
        };
        const merged = mergeUserSettings(current, {
            theme: "dark",
            taskDefaults: { summary: { tone: "funny" } },
            panel: { autoOpen: true },
        });

        expect(merged.theme).toBe("dark");
        expect(merged.density).toBe("comfortable");
        // summary.tone replaced, summary.length preserved (per-kind merge, not overwrite)
        expect(merged.taskDefaults?.summary).toEqual({ tone: "funny", length: "auto" });
        // ask untouched
        expect(merged.taskDefaults?.ask).toEqual({ lang: "en" });
        // panel.autoOpen replaced, defaultTab preserved
        expect(merged.panel).toEqual({ autoOpen: true, defaultTab: "summary" });
    });

    it("does not mutate the current object", () => {
        const current: UserSettings = { taskDefaults: { summary: { tone: "insightful" } } };
        mergeUserSettings(current, { taskDefaults: { summary: { tone: "funny" } } });

        expect(current.taskDefaults?.summary?.tone).toBe("insightful");
    });
});

describe("DEFAULT_USER_SETTINGS", () => {
    it("is system/comfortable", () => {
        expect(DEFAULT_USER_SETTINGS.theme).toBe("system");
        expect(DEFAULT_USER_SETTINGS.density).toBe("comfortable");
    });
});

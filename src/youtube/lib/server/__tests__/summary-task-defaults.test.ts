import { describe, expect, it } from "bun:test";
import { resolveSummaryControls, resolveSummaryLang } from "@app/youtube/lib/server/routes/videos";
import type { TaskDefaultSettings } from "@app/youtube/lib/user-settings";

const defaults: TaskDefaultSettings = { tone: "funny", format: "qa", length: "detailed", lang: "es" };

describe("resolveSummaryControls", () => {
    it("uses task defaults when the request omits controls", () => {
        expect(resolveSummaryControls({}, defaults)).toEqual({ tone: "funny", format: "qa", length: "detailed" });
    });

    it("explicit request params win over task defaults", () => {
        expect(resolveSummaryControls({ tone: "actionable", length: "short" }, defaults)).toEqual({
            tone: "actionable",
            format: "qa",
            length: "short",
        });
    });

    it("leaves controls undefined when neither request nor defaults set them", () => {
        expect(resolveSummaryControls({}, undefined)).toEqual({
            tone: undefined,
            format: undefined,
            length: undefined,
        });
    });

    it("ignores invalid request values and falls back to the default", () => {
        expect(resolveSummaryControls({ tone: "angry" }, defaults).tone).toBe("funny");
    });
});

describe("resolveSummaryLang", () => {
    it("valid explicit request lang wins", () => {
        expect(resolveSummaryLang("fr", defaults, "de")).toBe("fr");
    });

    it("falls back to task default lang when request omits it", () => {
        expect(resolveSummaryLang(undefined, defaults, "de")).toBe("es");
    });

    it("falls back to the user's global lang when no task default", () => {
        expect(resolveSummaryLang(undefined, {}, "de")).toBe("de");
    });

    it("falls back to en when nothing is set", () => {
        expect(resolveSummaryLang(undefined, undefined, null)).toBe("en");
    });

    it("ignores an invalid explicit lang and uses the default chain", () => {
        expect(resolveSummaryLang("zzz", defaults, "de")).toBe("es");
    });
});

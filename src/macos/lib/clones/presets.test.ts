import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import {
    getPreset,
    listPresets,
    type Preset,
    presetsPath,
    removePreset,
    savePreset,
    touchPreset,
} from "@app/macos/lib/clones/presets";

function preset(id: string): Preset {
    return {
        id,
        dirs: ["/tmp/gt-preset-fixture"],
        targets: ["gitignored"],
        exclude: [],
        minReal: 10485760,
        keepPartners: [],
        createdAt: "2026-09-02T10:00:00.000Z",
    };
}

afterEach(() => {
    if (existsSync(presetsPath())) {
        rmSync(presetsPath());
    }
});

describe("presets", () => {
    it("starts empty and round-trips a saved preset", () => {
        expect(listPresets()).toEqual([]);
        savePreset(preset("acme"));
        expect(getPreset("acme")).toEqual(preset("acme"));
        expect(listPresets().map((p) => p.id)).toEqual(["acme"]);
    });

    it("saving the same id replaces it instead of duplicating", () => {
        savePreset(preset("acme"));
        savePreset({ ...preset("acme"), targets: ["node_modules"] });
        expect(listPresets().length).toBe(1);
        expect(getPreset("acme")?.targets).toEqual(["node_modules"]);
    });

    it("lists ids sorted and removes by id", () => {
        savePreset(preset("beta"));
        savePreset(preset("alpha"));
        expect(listPresets().map((p) => p.id)).toEqual(["alpha", "beta"]);
        expect(removePreset("alpha")).toBe(true);
        expect(removePreset("alpha")).toBe(false);
        expect(listPresets().map((p) => p.id)).toEqual(["beta"]);
    });

    it("touchPreset records the last run without touching the selector", () => {
        savePreset(preset("acme"));
        touchPreset("acme", { lastRunAt: "2026-09-02T11:00:00.000Z", lastReclaimable: 1234 });
        const got = getPreset("acme");
        expect(got?.lastRunAt).toBe("2026-09-02T11:00:00.000Z");
        expect(got?.lastReclaimable).toBe(1234);
        expect(got?.targets).toEqual(["gitignored"]);
    });

    it("getPreset returns null for an unknown id", () => {
        expect(getPreset("nope")).toBeNull();
    });

    it("a corrupt presets.json reads as empty instead of crashing every preset verb", () => {
        writeFileSync(presetsPath(), '{"presets": [ {"id": "half"');
        expect(listPresets()).toEqual([]);
        expect(getPreset("half")).toBeNull();
        expect(removePreset("half")).toBe(false);
        savePreset(preset("fresh"));
        expect(listPresets().map((p) => p.id)).toEqual(["fresh"]);
    });
});

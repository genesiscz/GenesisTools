import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { jevSettingsPath, loadJevSettings, setJevSetting, unsetJevSetting } from "./settings";

let envSnapshot: ReturnType<typeof env.testing.snapshot>;

beforeEach(() => {
    envSnapshot = env.testing.snapshot();
    env.testing.set("GENESIS_TOOLS_HOME", mkdtempSync(join(tmpdir(), "jev-settings-")));
});

afterEach(() => {
    env.testing.restore(envSnapshot);
});

function plant(text: string): void {
    mkdirSync(dirname(jevSettingsPath()), { recursive: true });
    writeFileSync(jevSettingsPath(), text, { mode: 0o600 });
}

describe("setJevSetting", () => {
    test("refuses to save over settings that fail the schema, and leaves the file byte-identical", async () => {
        const planted = SafeJSON.stringify({ settings: { provider: "no-such-provider", stt: "fixture-stt" } });
        plant(planted);

        await expect(setJevSetting("language", "cs")).rejects.toThrow("left untouched");

        expect(readFileSync(jevSettingsPath(), "utf8")).toBe(planted);
        // Reading for display still works and falls back to no saved settings.
        expect(await loadJevSettings()).toEqual({});
    });

    test("explicitly null settings refuse set and unset without changing the file", async () => {
        const planted = SafeJSON.stringify({ settings: null });
        plant(planted);

        await expect(setJevSetting("language", "cs")).rejects.toThrow("left untouched");
        await expect(unsetJevSetting("language")).rejects.toThrow("left untouched");

        expect(readFileSync(jevSettingsPath(), "utf8")).toBe(planted);
        expect(await loadJevSettings()).toEqual({});
    });

    test("an absent settings key still uses defaults and accepts its first setting", async () => {
        plant("{}");

        await setJevSetting("language", "cs");

        expect(await loadJevSettings()).toEqual({ language: "cs" });
    });

    test("a valid file gains the new key and keeps the saved ones", async () => {
        plant(SafeJSON.stringify({ settings: { stt: "fixture-stt" } }));

        await setJevSetting("language", "cs");

        expect(await loadJevSettings()).toEqual({ stt: "fixture-stt", language: "cs" });
    });
});

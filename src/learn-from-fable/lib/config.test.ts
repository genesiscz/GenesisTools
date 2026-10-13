import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { bootstrapFableConfig, loadFableConfig } from "./config";

function configPath(): string {
    return join(mkdtempSync(join(tmpdir(), "lff-config-")), "config.json");
}

describe("bootstrapFableConfig", () => {
    test("refuses a config that does not parse and leaves its bytes in place", () => {
        const path = configPath();
        const planted = '{"packPath": "/packs/fable", "models": {"mine": "work/grok/grok-4.5"}, "no';
        writeFileSync(path, planted);

        expect(() => bootstrapFableConfig({ packPath: "/packs/other", notes: "fresh", path })).toThrow(path);
        expect(() => loadFableConfig(path)).toThrow("left untouched");
        expect(readFileSync(path, "utf-8")).toBe(planted);
    });

    test("a new pack path keeps the saved models and notes", () => {
        const path = configPath();
        writeFileSync(
            path,
            SafeJSON.stringify({ packPath: "/packs/fable", models: { mine: "work/grok/grok-4.5" }, notes: "mine" })
        );

        bootstrapFableConfig({ packPath: "/packs/other", notes: "fresh", path });

        expect(loadFableConfig(path)).toMatchObject({
            packPath: "/packs/other",
            models: { mine: "work/grok/grok-4.5" },
            notes: "mine",
        });
    });

    test("with no config yet it writes one with the given notes", () => {
        const path = configPath();

        bootstrapFableConfig({ packPath: "/packs/fable", notes: "fresh", path });

        expect(loadFableConfig(path)).toMatchObject({ packPath: "/packs/fable", notes: "fresh" });
    });
});

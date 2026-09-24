import { describe, expect, test } from "bun:test";
import { linkFor, presetEnabled } from "./links";

describe("linkFor", () => {
    test("returns null when the router is not installed", () => {
        expect(linkFor("cmux-claude", { installed: false, presets: ["cmux-claude"] }, "https://x", "Run")).toBeNull();
    });

    test("returns null when the preset is off", () => {
        expect(presetEnabled("cmux-claude", ["mail"])).toBe(false);
        expect(linkFor("cmux-claude", { installed: true, presets: ["mail"] }, "https://x", "Run")).toBeNull();
    });

    test("returns markdown when the preset is on", () => {
        expect(linkFor("cmux-claude", { installed: true, presets: ["cmux-claude"] }, "https://x", "Run")).toEqual({
            url: "https://x",
            markdown: "[Run](https://x)",
        });
    });
});

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseBrewOutdated } from "@app/doctor/analyzers/brew";

describe("parseBrewOutdated", () => {
    it("parses formulae and casks from brew outdated JSON", () => {
        const raw = readFileSync(join(import.meta.dir, "fixtures", "brew-outdated.json"), "utf8");
        const outdated = parseBrewOutdated(raw);

        expect(outdated).toContainEqual({
            name: "git",
            installed: ["2.44.0"],
            current: "2.45.0",
        });
        expect(outdated).toContainEqual({
            name: "visual-studio-code",
            installed: ["1.88.0"],
            current: "1.89.0",
        });
    });

    it("returns [] for invalid JSON", () => {
        expect(parseBrewOutdated("not json")).toEqual([]);
    });
});

import { describe, expect, it } from "bun:test";
import { buildEmptyScript, buildMoveScript } from "../trash-staging";

describe("trash-staging applescript", () => {
    it("builds move-to-trash script escaping double quotes", () => {
        const script = buildMoveScript('/path/to/file with "quotes".dmg');

        expect(script).toContain('POSIX file "/path/to/file with \\"quotes\\".dmg"');
        expect(script).toContain('tell application "Finder"');
        expect(script).toContain("delete");
    });

    it("empty-trash script is simple", () => {
        expect(buildEmptyScript()).toBe('tell application "Finder" to empty trash');
    });
});

import { describe, expect, it } from "bun:test";
import { resolveTheme } from "@app/yt/lib/appearance";

describe("resolveTheme", () => {
    it("explicit light/dark ignore the OS preference", () => {
        expect(resolveTheme("light", true)).toBe("light");
        expect(resolveTheme("dark", false)).toBe("dark");
    });

    it("system follows the OS preference", () => {
        expect(resolveTheme("system", true)).toBe("dark");
        expect(resolveTheme("system", false)).toBe("light");
    });

    it("undefined theme is treated as system", () => {
        expect(resolveTheme(undefined, true)).toBe("dark");
        expect(resolveTheme(undefined, false)).toBe("light");
    });
});

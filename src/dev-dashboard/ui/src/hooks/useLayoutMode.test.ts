import { describe, expect, test } from "bun:test";
import { resolveLayoutMode } from "./useLayoutMode";

describe("resolveLayoutMode", () => {
    test("mobile forces focused regardless of stored pref", () => {
        expect(resolveLayoutMode({ isMobile: true, stored: "mosaic" })).toBe("focused");
        expect(resolveLayoutMode({ isMobile: true, stored: null })).toBe("focused");
    });

    test("desktop uses stored pref, defaulting to mosaic", () => {
        expect(resolveLayoutMode({ isMobile: false, stored: null })).toBe("mosaic");
        expect(resolveLayoutMode({ isMobile: false, stored: "focused" })).toBe("focused");
        expect(resolveLayoutMode({ isMobile: false, stored: "mosaic" })).toBe("mosaic");
    });
});

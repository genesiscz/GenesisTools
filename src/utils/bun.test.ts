import { describe, expect, it } from "bun:test";
import { detectBunCapabilities, requireHeadlessBrowser } from "./bun";

describe("detectBunCapabilities", () => {
    it("parses Bun.version correctly", () => {
        const caps = detectBunCapabilities();
        expect(caps.bunVersion.major).toBeGreaterThanOrEqual(1);
    });

    it("returns headlessBrowser true on Bun >= 1.3.12", () => {
        const caps = detectBunCapabilities();
        const { major, minor, patch } = caps.bunVersion;
        const meetsMin = major > 1 || (major === 1 && (minor > 3 || (minor === 3 && patch >= 12)));
        expect(caps.headlessBrowser).toBe(meetsMin);
    });
});

describe("requireHeadlessBrowser", () => {
    it("does not throw on current Bun version when WebView is available", () => {
        const caps = detectBunCapabilities();

        if (!caps.headlessBrowser) {
            return;
        }

        expect(() => requireHeadlessBrowser()).not.toThrow();
    });
});

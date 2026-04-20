import { describe, expect, it } from "bun:test";
import { buildInstallPrompt } from "../offer-install";

describe("offer-install", () => {
    it("builds prompt message with why and command preview", () => {
        const message = buildInstallPrompt({ tool: "fd", command: "brew install fd", why: "faster scans" });

        expect(message).toContain("fd");
        expect(message).toContain("faster scans");
        expect(message).toContain("brew install fd");
    });
});

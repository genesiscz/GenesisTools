import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isFileVaultEnabled, isGatekeeperEnabled, isSipEnabled } from "@app/doctor/analyzers/security";

const FIXTURES = join(import.meta.dir, "fixtures");

describe("security output checks", () => {
    it("detects FileVault as enabled", () => {
        const raw = readFileSync(join(FIXTURES, "fdesetup-status.txt"), "utf8");
        expect(isFileVaultEnabled(raw)).toBe(true);
    });

    it("detects Gatekeeper as enabled", () => {
        expect(isGatekeeperEnabled("assessments enabled\n")).toBe(true);
    });

    it("detects SIP as enabled", () => {
        expect(isSipEnabled("System Integrity Protection status: enabled.\n")).toBe(true);
    });
});

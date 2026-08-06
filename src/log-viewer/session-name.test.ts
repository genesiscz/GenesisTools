import { describe, expect, it } from "bun:test";
import { isSafeLogSessionName } from "./session-name";

describe("isSafeLogSessionName", () => {
    it("accepts dash-format task collision suffix (NTFS-safe)", () => {
        expect(isSafeLogSessionName("metro-2026-05-26_14-30-22")).toBe(true);
    });

    it("rejects legacy colon-format suffixes (Windows-illegal)", () => {
        expect(isSafeLogSessionName("metro-2026-05-26_14:30:22")).toBe(false);
    });

    it("accepts plain alphanumeric session names", () => {
        expect(isSafeLogSessionName("eval2-storm")).toBe(true);
        expect(isSafeLogSessionName("dash-1779747032065")).toBe(true);
    });

    it("accepts dotted backup session names", () => {
        expect(isSafeLogSessionName("reg-device-288060.backup-fix-023257")).toBe(true);
        expect(isSafeLogSessionName("reg-device-288060.backup-20260603-234054")).toBe(true);
    });

    it("rejects path traversal and slashes", () => {
        expect(isSafeLogSessionName("../etc/passwd")).toBe(false);
        expect(isSafeLogSessionName("foo/bar")).toBe(false);
        expect(isSafeLogSessionName("..")).toBe(false);
        expect(isSafeLogSessionName(".")).toBe(false);
        expect(isSafeLogSessionName("foo/../bar")).toBe(false);
        expect(isSafeLogSessionName("foo\\bar")).toBe(false);
    });

    it("rejects leading and trailing dots (hidden files, Windows strips trailing dots)", () => {
        expect(isSafeLogSessionName(".hidden")).toBe(false);
        expect(isSafeLogSessionName("foo.")).toBe(false);
    });

    it("rejects empty", () => {
        expect(isSafeLogSessionName("")).toBe(false);
    });
});

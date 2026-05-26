import { describe, expect, it } from "bun:test";
import { isSafeLogSessionName } from "./session-name";

describe("isSafeLogSessionName", () => {
    it("accepts task collision suffix with colons", () => {
        expect(isSafeLogSessionName("metro-2026-05-26_14:30:22")).toBe(true);
    });

    it("accepts plain alphanumeric session names", () => {
        expect(isSafeLogSessionName("eval2-storm")).toBe(true);
        expect(isSafeLogSessionName("dash-1779747032065")).toBe(true);
    });

    it("rejects path traversal and slashes", () => {
        expect(isSafeLogSessionName("../etc/passwd")).toBe(false);
        expect(isSafeLogSessionName("foo/bar")).toBe(false);
    });

    it("rejects empty", () => {
        expect(isSafeLogSessionName("")).toBe(false);
    });
});

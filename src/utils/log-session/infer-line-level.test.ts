import { describe, expect, it } from "bun:test";
import { inferLineLevel } from "./infer-line-level";

describe("inferLineLevel", () => {
    it("neutral stderr stays info", () => {
        expect(inferLineLevel("stderr", "plain message\n")).toBe("info");
    });

    it("infers warn from stderr WARN text", () => {
        expect(inferLineLevel("stderr", "▲ WARN  Fast Refresh reload batch\r")).toBe("warn");
        expect(inferLineLevel("stderr", " WARN  Ignoring DevTools app debug target\r")).toBe("warn");
    });

    it("keeps stderr INFO lines as info", () => {
        expect(inferLineLevel("stderr", "INFO  EVAL2_HUNT_TOKEN=HUNT-EVAL2-1779756173\r")).toBe("info");
    });

    it("infers error from stderr error text", () => {
        expect(inferLineLevel("stderr", "Error: TransformError: something failed\r")).toBe("error");
        expect(inferLineLevel("stderr", "npm ERR! code ELIFECYCLE\r")).toBe("error");
    });

    it("infers error from stderr stack frames", () => {
        expect(inferLineLevel("stderr", "    at deserialize (node:v8:468:7)\r")).toBe("error");
    });

    it("bumps PTY stdout Error lines to error", () => {
        expect(inferLineLevel("stdout", "Error while reading cache, falling back to a full crawl:\r")).toBe("error");
        expect(inferLineLevel("stdout", " Error: Unable to deserialize cloned data due to invalid version.\r")).toBe(
            "error"
        );
        expect(inferLineLevel("stdout", "    at deserialize (node:v8:468:7)\r")).toBe("error");
    });

    it("bumps Metro WARN lines to warn", () => {
        expect(inferLineLevel("stdout", " WARN  Ignoring DevTools app debug target\r")).toBe("warn");
    });

    it("leaves normal stdout as info", () => {
        expect(inferLineLevel("stdout", " INFO  Launching DevTools...\r")).toBe("info");
        expect(inferLineLevel("stdout", "[app.config.ts] APP_ENV=test\r")).toBe("info");
    });

    it("prefers error over warn when both match", () => {
        expect(inferLineLevel("stdout", "WARN: Error: something failed\r")).toBe("error");
    });
});

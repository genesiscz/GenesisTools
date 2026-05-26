import { describe, expect, it } from "bun:test";
import { inferLineLevel } from "./infer-line-level";

describe("inferLineLevel", () => {
    it("keeps stderr stream at error when text is neutral", () => {
        expect(inferLineLevel("stderr", "plain message\n")).toBe("error");
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

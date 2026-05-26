import { describe, expect, it } from "bun:test";
import { collapsePathForDisplay, toPosixPath } from "./paths.client";

describe("paths.client", () => {
    it("normalizes backslashes", () => {
        expect(toPosixPath("a\\b\\c")).toBe("a/b/c");
    });

    it("collapses mac home paths to tilde", () => {
        expect(collapsePathForDisplay("/Users/dev/Projects/app")).toBe("~/Projects/app");
    });

    it("leaves non-home absolute paths unchanged", () => {
        expect(collapsePathForDisplay("/var/log/syslog")).toBe("/var/log/syslog");
    });
});

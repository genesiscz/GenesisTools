import { describe, expect, it } from "bun:test";
import { assertBoundServersResponded } from "./discover.ts";

describe("assertBoundServersResponded", () => {
    const errors = [
        { server: "chrome-devtools-mcp", error: "spawn ENOENT" },
        { server: "never-bound", error: "irrelevant" },
    ];

    it("throws when a previously bound server failed to respond — write is never reached", () => {
        expect(() => assertBoundServersResponded(["chrome-devtools-mcp", "gh_grep"], errors, false)).toThrow(
            /chrome-devtools-mcp did not respond.*--force/
        );
    });

    it("--force accepts the loss and lets the rewrite proceed", () => {
        expect(() => assertBoundServersResponded(["chrome-devtools-mcp"], errors, true)).not.toThrow();
    });

    it("failures on servers that were never bound do not block", () => {
        expect(() => assertBoundServersResponded(["gh_grep"], errors, false)).not.toThrow();
    });

    it("no failures at all is the trivial pass", () => {
        expect(() => assertBoundServersResponded(["gh_grep"], [], false)).not.toThrow();
    });
});

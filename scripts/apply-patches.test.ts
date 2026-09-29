import { describe, expect, test } from "bun:test";
import { fixedUpstream, PATCHES } from "./apply-patches";

describe("apply-patches", () => {
    // An install that moves vite past 8.2.2 must not fail the postinstall on a patch it no longer needs.
    test("the vite patch is skipped from the release that ships its fix, and applied before it", () => {
        const vite = PATCHES.find((entry) => entry.pkg === "node_modules/vite");

        expect(vite).toBeDefined();

        if (!vite) {
            return;
        }

        expect(fixedUpstream(vite, "8.2.2")).toBe(false);
        expect(fixedUpstream(vite, "8.3.1")).toBe(true);
        expect(fixedUpstream(vite, "9.0.0")).toBe(true);
        expect(fixedUpstream(vite, null)).toBe(false);
    });

    test("a patch with no upstream release keeps failing on drift", () => {
        expect(fixedUpstream({ pkg: "node_modules/cli-table3", patch: "p.patch" }, "9.9.9")).toBe(false);
    });
});

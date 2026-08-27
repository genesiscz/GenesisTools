import { describe, expect, test } from "bun:test";
import { resolveTarget } from "./open-session";

describe("resolveTarget", () => {
    test("window alone", () => {
        expect(resolveTarget({ window: "window:1" })).toEqual({ kind: "window", windowRef: "window:1" });
    });

    test("workspace alone", () => {
        expect(resolveTarget({ workspace: "workspace:2" })).toEqual({ kind: "workspace", workspaceRef: "workspace:2" });
    });

    test("pane needs workspace", () => {
        expect(typeof resolveTarget({ pane: "pane:3" })).toBe("string");
        expect(resolveTarget({ workspace: "workspace:2", pane: "pane:3" })).toEqual({
            kind: "pane",
            workspaceRef: "workspace:2",
            paneRef: "pane:3",
        });
    });

    test("surface needs workspace", () => {
        expect(typeof resolveTarget({ surface: "surface:4" })).toBe("string");
        expect(resolveTarget({ workspace: "workspace:2", surface: "surface:4" })).toEqual({
            kind: "surface",
            workspaceRef: "workspace:2",
            surfaceRef: "surface:4",
        });
    });

    test("zero or too many targets refuse", () => {
        expect(typeof resolveTarget({})).toBe("string");
        expect(typeof resolveTarget({ window: "window:1", workspace: "workspace:2" })).toBe("string");
        expect(typeof resolveTarget({ workspace: "w", pane: "p", surface: "s" })).toBe("string");
    });
});

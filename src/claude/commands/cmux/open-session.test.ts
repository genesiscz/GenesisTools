import { describe, expect, test } from "bun:test";
import { resolveTarget } from "./open-session";

const WINDOW = "0B000000-0000-4000-8000-000000000001";
const WORKSPACE = "11111111-1111-4111-8111-111111111112";
const PANE = "22222222-2222-4222-8222-222222222203";
const SURFACE = "33333333-3333-4333-8333-333333333304";

describe("resolveTarget", () => {
    test("window alone", () => {
        expect(resolveTarget({ window: WINDOW })).toEqual({ kind: "window", windowId: WINDOW });
    });

    test("workspace alone", () => {
        expect(resolveTarget({ workspace: WORKSPACE })).toEqual({ kind: "workspace", workspaceId: WORKSPACE });
    });

    test("pane needs workspace", () => {
        expect(typeof resolveTarget({ pane: PANE })).toBe("string");
        expect(resolveTarget({ workspace: WORKSPACE, pane: PANE })).toEqual({
            kind: "pane",
            workspaceId: WORKSPACE,
            paneId: PANE,
        });
    });

    test("surface needs workspace", () => {
        expect(typeof resolveTarget({ surface: SURFACE })).toBe("string");
        expect(resolveTarget({ workspace: WORKSPACE, surface: SURFACE })).toEqual({
            kind: "surface",
            workspaceId: WORKSPACE,
            surfaceId: SURFACE,
        });
    });

    test("a ref typed by a human passes through; cmux accepts it", () => {
        expect(resolveTarget({ workspace: "workspace:2", surface: "surface:4" })).toEqual({
            kind: "surface",
            workspaceId: "workspace:2",
            surfaceId: "surface:4",
        });
    });

    test("zero or too many targets refuse", () => {
        expect(typeof resolveTarget({})).toBe("string");
        expect(typeof resolveTarget({ window: WINDOW, workspace: WORKSPACE })).toBe("string");
        expect(typeof resolveTarget({ workspace: "w", pane: "p", surface: "s" })).toBe("string");
    });
});

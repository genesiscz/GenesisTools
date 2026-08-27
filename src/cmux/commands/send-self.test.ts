import { describe, expect, it } from "bun:test";
import { resolveSelfTarget } from "@app/cmux/commands/send-self";

const CMUX_ENV = {
    CMUX_SURFACE_ID: "F89A4C33",
    CMUX_WORKSPACE_ID: "C0503E81",
} as NodeJS.ProcessEnv;

describe("resolveSelfTarget", () => {
    it("returns null outside tmux and cmux", () => {
        expect(resolveSelfTarget({} as NodeJS.ProcessEnv)).toBeNull();
    });

    it("resolves cmux from surface and workspace ids", () => {
        expect(resolveSelfTarget(CMUX_ENV)).toEqual({
            kind: "cmux",
            workspaceId: "C0503E81",
            surfaceId: "F89A4C33",
        });
    });

    /**
     * Behaviour change 2026-08-28: the surface used to be useless without a
     * workspace, so this returned null. The workspace is now dropped from the
     * command line for a self-identifying surface — it could only ever scope
     * the lookup WRONG — so the surface alone is a complete target.
     */
    it("resolves cmux from the surface alone", () => {
        expect(resolveSelfTarget({ CMUX_SURFACE_ID: "F89A4C33" } as NodeJS.ProcessEnv)).toEqual({
            kind: "cmux",
            workspaceId: undefined,
            surfaceId: "F89A4C33",
        });
    });

    it("still returns null when the surface id is missing", () => {
        expect(resolveSelfTarget({ CMUX_WORKSPACE_ID: "C0503E81" } as NodeJS.ProcessEnv)).toBeNull();
    });

    it("prefers tmux when nested inside cmux", () => {
        const nested = { ...CMUX_ENV, TMUX_PANE: "%7" } as NodeJS.ProcessEnv;
        expect(resolveSelfTarget(nested)).toEqual({ kind: "tmux", pane: "%7" });
    });

    it("honours a forced transport", () => {
        const nested = { ...CMUX_ENV, TMUX_PANE: "%7" } as NodeJS.ProcessEnv;
        expect(resolveSelfTarget(nested, "cmux")).toEqual({
            kind: "cmux",
            workspaceId: "C0503E81",
            surfaceId: "F89A4C33",
        });
        expect(resolveSelfTarget(CMUX_ENV, "tmux")).toBeNull();
    });
});

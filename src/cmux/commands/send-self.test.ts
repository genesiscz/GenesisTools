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

    // Characterization (2026-11-04): TMUX_PANE is read first, and an empty one does not count.
    it("reads TMUX_PANE before CMUX_SURFACE_ID, and an empty TMUX_PANE falls through to cmux", () => {
        expect(resolveSelfTarget({ TMUX_PANE: "%2", CMUX_SURFACE_ID: "F89A4C33" } as NodeJS.ProcessEnv)).toEqual({
            kind: "tmux",
            pane: "%2",
        });
        expect(resolveSelfTarget({ TMUX_PANE: "", CMUX_SURFACE_ID: "F89A4C33" } as NodeJS.ProcessEnv)).toEqual({
            kind: "cmux",
            workspaceId: undefined,
            surfaceId: "F89A4C33",
        });
    });

    it("tmux alone resolves without any cmux id, and forcing cmux on a tmux-only env is null", () => {
        const tmuxOnly = { TMUX_PANE: "%2" } as NodeJS.ProcessEnv;
        expect(resolveSelfTarget(tmuxOnly)).toEqual({ kind: "tmux", pane: "%2" });
        expect(resolveSelfTarget(tmuxOnly, "cmux")).toBeNull();
    });
});

describe("characterization: blank terminal ids", () => {
    it("a whitespace-only tmux pane names no pane, so a valid cmux surface wins", () => {
        expect(resolveSelfTarget({ ...CMUX_ENV, TMUX_PANE: " \t " })).toEqual({
            kind: "cmux",
            surfaceId: "F89A4C33",
            workspaceId: "C0503E81",
        });
        expect(resolveSelfTarget({ ...CMUX_ENV, TMUX_PANE: " %3 " })).toEqual({ kind: "tmux", pane: "%3" });
        expect(resolveSelfTarget({ ...CMUX_ENV, TMUX_PANE: " \t " }, "cmux")).toEqual({
            kind: "cmux",
            surfaceId: "F89A4C33",
            workspaceId: "C0503E81",
        });
    });

    it("an empty surface is absent, but a whitespace surface and blank workspace are kept verbatim", () => {
        expect(resolveSelfTarget({ CMUX_SURFACE_ID: "", CMUX_WORKSPACE_ID: "workspace" })).toBeNull();
        expect(resolveSelfTarget({ CMUX_SURFACE_ID: " \t ", CMUX_WORKSPACE_ID: "" })).toEqual({
            kind: "cmux",
            surfaceId: " \t ",
            workspaceId: "",
        });
    });

    it("forcing tmux with an empty pane cannot fall back to a valid cmux surface", () => {
        expect(resolveSelfTarget({ ...CMUX_ENV, TMUX_PANE: "" }, "tmux")).toBeNull();
    });
});

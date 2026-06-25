import { describe, expect, it } from "bun:test";
import {
    clearAllPaneWrapOverrides,
    loadPaneWrapOverrides,
    resolveWrapLongLines,
    setPaneWrapOverride,
} from "@app/debugging-master/dashboard/lib/pane-display-overrides";

describe("pane-display-overrides", () => {
    it("resolves global when no pane override exists", () => {
        clearAllPaneWrapOverrides();
        expect(resolveWrapLongLines(true, "pane-a")).toBe(true);
        expect(resolveWrapLongLines(false, "pane-a")).toBe(false);
    });

    it("uses pane override when set", () => {
        clearAllPaneWrapOverrides();
        setPaneWrapOverride("pane-a", false);
        expect(resolveWrapLongLines(true, "pane-a")).toBe(false);
        expect(loadPaneWrapOverrides()["pane-a"]).toBe(false);
    });
});

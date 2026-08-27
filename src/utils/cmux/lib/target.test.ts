import { describe, expect, test } from "bun:test";
import { isSelfIdentifyingSurface, surfaceTargetArgs } from "@genesiscz/utils/cmux/lib/target";

/**
 * Regression test: a stale CMUX_WORKSPACE_ID made `cmux send` reject a real
 * terminal with `invalid_params: Surface is not a terminal`, because the surface
 * was looked up inside a workspace it no longer belonged to.
 */
describe("surfaceTargetArgs", () => {
    const uuid = "03DA1B10-D019-4CF2-8014-5F0AFB7BAF88";
    const workspace = "04AA5245-8C6E-427B-AFDF-9937CFE1D36F";

    test("a surface UUID is sent without a workspace, so a stale one cannot scope it away", () => {
        expect(surfaceTargetArgs(uuid, workspace)).toEqual(["--surface", uuid]);
    });

    test("a surface ref is equally self-identifying", () => {
        expect(surfaceTargetArgs("surface:94", workspace)).toEqual(["--surface", "surface:94"]);
    });

    test("a bare index is workspace-relative, so the workspace is kept", () => {
        expect(surfaceTargetArgs("4", workspace)).toEqual(["--workspace", workspace, "--surface", "4"]);
    });

    test("no workspace to drop is not an error", () => {
        expect(surfaceTargetArgs("4")).toEqual(["--surface", "4"]);
    });
});

describe("isSelfIdentifyingSurface", () => {
    test("uuid, surface ref and tab ref identify a surface on their own", () => {
        expect(isSelfIdentifyingSurface("03da1b10-d019-4cf2-8014-5f0afb7baf88")).toBe(true);
        expect(isSelfIdentifyingSurface("surface:94")).toBe(true);
        expect(isSelfIdentifyingSurface("tab:94")).toBe(true);
    });

    test("a bare index does not", () => {
        expect(isSelfIdentifyingSurface("4")).toBe(false);
        expect(isSelfIdentifyingSurface("")).toBe(false);
    });
});

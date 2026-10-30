import { describe, expect, it } from "bun:test";
import {
    comparePairGeometry,
    geometrySidecarPath,
    parseSnapshotGeometry,
    type SnapshotGeometry,
} from "./snapshot-geometry";

function shot(width: number, height: number, scale: number): SnapshotGeometry {
    const parsed = parseSnapshotGeometry({
        version: 1,
        face: "hub",
        window: { width, height },
        scale,
        backingScale: scale,
        image: { width: width * scale, height: height * scale },
        build: { binary: "1D120A40-0000-0000-0000-000000000000", commit: null, commitSource: "unknown" },
        capturedAt: "2026-10-30T19:53:20Z",
    });
    if (!parsed) {
        throw new Error("fixture does not parse");
    }

    return parsed;
}

describe("snapshot geometry", () => {
    it("names the sidecar beside the PNG", () => {
        expect(geometrySidecarPath("/tmp/x/01-hub-1-before.png")).toBe("/tmp/x/01-hub-1-before.geometry.json");
    });

    it("refuses a pair drawn at different point sizes and names both", () => {
        const verdict = comparePairGeometry(shot(2056, 1290, 2), shot(1440, 900, 2));
        expect(verdict.kind).toBe("size-mismatch");
        expect(verdict.kind === "size-mismatch" && verdict.message).toBe(
            "capture size differs: A is 2056x1290 pt @2x, B is 1440x900 pt @2x"
        );
    });

    it("resamples the same point size at another scale and says so", () => {
        const verdict = comparePairGeometry(shot(1440, 900, 2), shot(1440, 900, 1));
        expect(verdict.kind).toBe("rescale");
        expect(verdict.kind === "rescale" && verdict.message).toBe(
            "B resampled from @1x to A's @2x (both 1440x900 pt)"
        );
    });

    it("accepts a matching pair and falls back to pixels without sidecars", () => {
        expect(comparePairGeometry(shot(1440, 900, 2), shot(1440, 900, 2)).kind).toBe("same");
        expect(comparePairGeometry(undefined, shot(1440, 900, 2))).toEqual({ kind: "unknown", missing: ["a"] });
        expect(parseSnapshotGeometry({ version: 1, window: { width: "wide" } })).toBeUndefined();
    });
});

import { describe, expect, test } from "bun:test";
import { emitCloseMarker, emitOpenMarker, type MarkerMeta, parseMarkers, stripMarkers } from "./markers";

describe("markers", () => {
    test("emit open marker for // syntax", () => {
        const meta: MarkerMeta = { id: "3f2a8b", v: 2 };
        const line = emitOpenMarker({ name: "debug-logger", meta, syntax: { line: "//", block: null } });
        expect(line).toBe(`// #region @stash:debug-logger {"id":"3f2a8b","v":2}`);
    });

    test("emit open marker for # syntax", () => {
        const meta: MarkerMeta = { id: "3f2a8b", v: 1 };
        const line = emitOpenMarker({ name: "x", meta, syntax: { line: "#", block: null } });
        expect(line).toBe(`# #region @stash:x {"id":"3f2a8b","v":1}`);
    });

    test("emit open marker for block-only (HTML)", () => {
        const meta: MarkerMeta = { id: "abc", v: 1 };
        const line = emitOpenMarker({
            name: "x",
            meta,
            syntax: { line: null, block: { open: "<!--", close: "-->" } },
        });
        expect(line).toBe(`<!-- #region @stash:x {"id":"abc","v":1} -->`);
    });

    test("emit close marker (bare)", () => {
        const line = emitCloseMarker({ name: "debug-logger", syntax: { line: "//", block: null } });
        expect(line).toBe(`// #endregion @stash:debug-logger`);
    });

    test("parseMarkers finds open+close pair in TS file", () => {
        const src = [
            "function foo() {",
            `    // #region @stash:debug-logger {"id":"3f2a8b","v":2}`,
            "    console.log('debug');",
            "    // #endregion @stash:debug-logger",
            "}",
        ].join("\n");
        const found = parseMarkers(src);
        expect(found).toHaveLength(1);
        expect(found[0]?.name).toBe("debug-logger");
        expect(found[0]?.meta.id).toBe("3f2a8b");
        expect(found[0]?.meta.v).toBe(2);
        expect(found[0]?.startLine).toBe(2);
        expect(found[0]?.endLine).toBe(4);
    });

    test("parseMarkers handles bare author markers (no JSON)", () => {
        const src = [`// #region @stash:debug-logger`, `x();`, `// #endregion @stash:debug-logger`].join("\n");
        const found = parseMarkers(src);
        expect(found).toHaveLength(1);
        expect(found[0]?.meta).toEqual({});
    });

    test("stripMarkers removes both open and close lines", () => {
        const src = [
            "before",
            `// #region @stash:x {"id":"abc","v":1}`,
            "inside",
            "// #endregion @stash:x",
            "after",
        ].join("\n");
        expect(stripMarkers(src)).toBe(["before", "inside", "after"].join("\n"));
    });

    test("stripMarkers only removes @stash markers, not unrelated #region", () => {
        const src = ["// #region someOtherRegion", "x", "// #endregion someOtherRegion"].join("\n");
        expect(stripMarkers(src)).toBe(src);
    });

    test("CSS round-trip: emit → parse → strip re-emits the same body (PR #222 t17)", () => {
        // Regression: OPEN_RE's tail used `\/\*` (block-open) but CSS emits `*/` (block-close), so
        // markers in .css/.scss/.less files silently failed to parse and were never stripped.
        const cssSyntax = { line: null, block: { open: "/*", close: "*/" } };
        const meta: MarkerMeta = { id: "abc", v: 1 };
        const opener = emitOpenMarker({ name: "x", meta, syntax: cssSyntax });
        const closer = emitCloseMarker({ name: "x", syntax: cssSyntax });
        expect(opener).toBe(`/* #region @stash:x {"id":"abc","v":1} */`);
        expect(closer).toBe(`/* #endregion @stash:x */`);
        const src = [".body { color: red; }", opener, ".inside { color: blue; }", closer, ".after {}"].join("\n");
        const found = parseMarkers(src);
        expect(found).toHaveLength(1);
        expect(found[0]?.name).toBe("x");
        expect(found[0]?.meta.id).toBe("abc");
        expect(stripMarkers(src)).toBe([".body { color: red; }", ".inside { color: blue; }", ".after {}"].join("\n"));
    });
});

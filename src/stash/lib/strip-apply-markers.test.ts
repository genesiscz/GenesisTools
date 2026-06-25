import { describe, expect, test } from "bun:test";
import { stripApplyMarkersFromPatchFiles } from "./strip-apply-markers";

describe("stripApplyMarkersFromPatchFiles", () => {
    test("preserves author region nested inside apply-time wrapper with same name", () => {
        const patch = [
            "+++ b/foo.ts",
            "@@ -1,1 +1,7 @@",
            "+// #region @stash:foo {\"id\":\"abc\"}",
            "+line1",
            "+// #region @stash:foo",
            "+author",
            "+// #endregion @stash:foo",
            "+line2",
            "+// #endregion @stash:foo",
        ].join("\n");

        const stripped = stripApplyMarkersFromPatchFiles({ patch });
        expect(stripped).not.toContain('{"id":"abc"}');
        expect(stripped).toContain("+// #region @stash:foo");
        expect(stripped).toContain("+// #endregion @stash:foo");
        expect(stripped).toContain("+author");
        expect(stripped).toContain("+line1");
        expect(stripped).toContain("+line2");
        expect(stripped).toMatch(/\+1,5/);
    });

    test("drops nested apply-time openers with the same name", () => {
        const patch = [
            "+++ b/foo.ts",
            "@@ -1,1 +1,5 @@",
            "+// #region @stash:foo {\"id\":\"a\"}",
            "+// #region @stash:foo {\"id\":\"b\"}",
            "+x",
            "+// #endregion @stash:foo",
            "+// #endregion @stash:foo",
        ].join("\n");

        const stripped = stripApplyMarkersFromPatchFiles({ patch });
        expect(stripped).not.toContain("#region @stash:foo");
        expect(stripped).not.toContain("#endregion @stash:foo");
        expect(stripped).toContain("+x");
        expect(stripped).toMatch(/\+1,1/);
    });
});
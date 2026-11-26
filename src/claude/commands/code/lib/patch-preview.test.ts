import { expect, test } from "bun:test";
import { definePatch } from "../../../lib/patches/define-patch";
import { renderPatchPreview, renderRecoveryPreview } from "./patch-preview";

const patch = definePatch({
    id: "preview-test",
    description: "Change the fixture initializer",
    find: "old",
    replace: "new",
});
const original = 'p()?"first":q()?"second":void 0';
const replacement = "1".padEnd(original.length);

test("recovery still shows source when the formatter rejects it", () => {
    const preview = renderRecoveryPreview("main.js", Buffer.from("const = old"), Buffer.from("const = new"));
    expect(preview).toContain("-const = old");
    expect(preview).toContain("+const = new");
});

test("shows formatted JavaScript and the following guard for a minified edit", () => {
    const source = `function f(){let n=${original};if(n===void 0)return;return restart(n)}`;
    const start = source.indexOf(original);
    const item = { patch, source, module: "main.js", edit: { start, end: start + original.length, replacement } };
    const preview = renderPatchPreview({ ...item, applied: false });

    expect(preview).toContain('p() ? "first"');
    expect(preview).toContain("+    let n = 1;");
    expect(preview).toContain("if (n === void 0) return;");
    expect(preview).toContain("return restart(n);");
    expect(preview).not.toContain(replacement);
    expect(renderPatchPreview({ ...item, applied: true })).toContain("-    let n = 1;");
});

test("formats the module for an edit outside any function or guard", () => {
    const source = `let n=${original};console.log(n);`;
    const start = source.indexOf(original);
    const preview = renderPatchPreview({
        patch,
        source,
        module: "main.js",
        edit: { start, end: start + original.length, replacement },
        applied: false,
    });

    expect(preview).toContain("+let n = 1;");
    expect(preview).toContain("console.log(n);");
});

test("recovery preview compares installed code with the rebuilt selection", () => {
    const installed = Buffer.from('function f(){if(!ready())return"admin_unread";return 0}');
    const rebuilt = Buffer.from('function f(){if(!ready()||true)return"admin_unread";return 0}');
    const preview = renderRecoveryPreview("main.js", installed, rebuilt);

    expect(preview).toContain('-    if (!ready()) return "admin_unread";');
    expect(preview).toContain('+    if (!ready() || true) return "admin_unread";');
    expect(preview).toContain("return 0;");
});

import { describe, expect, test } from "bun:test";
import { normalizeIdentifiers } from "./normalize";

describe("normalizeIdentifiers", () => {
    test("renames bindings and references, keeps property names, keys, strings", () => {
        const out = normalizeIdentifiers('let qZx = { foo: 1 }; qZx.bar = wYv("isMeta", qZx.foo);');
        expect(out).toContain("let ID = { foo: 1 }");
        expect(out).toContain('ID.bar = ID("isMeta", ID.foo)');
        expect(out).not.toContain("qZx");
        expect(out).not.toContain("wYv");
    });

    test("template literals do not poison later code", () => {
        const src = "let a = `tick ${x} \\` done`; let zK9 = 1;";
        const out = normalizeIdentifiers(src);
        expect(out).toContain("let ID = 1;");
        expect(out).not.toContain("zK9");
    });

    test("shorthand object properties keep their (semantic) name", () => {
        const out = normalizeIdentifiers("let o = { foo, bar: 1 };");
        expect(out).toBe("let ID = { foo, bar: 1 };");
    });

    test("shorthand destructuring patterns keep their (semantic) name", () => {
        const out = normalizeIdentifiers("let { foo } = obj;");
        expect(out).toBe("let { foo } = ID;");
    });

    test("computed member expressions ARE normalized", () => {
        const out = normalizeIdentifiers("obj[key] = 1;");
        expect(out).toBe("ID[ID] = 1;");
    });

    test("line count is preserved (chunking depends on this)", () => {
        const src = "let a = 1;\nlet b = 2;\nfunction c(d) {\n  return d;\n}\n";
        expect(normalizeIdentifiers(src).split("\n").length).toBe(src.split("\n").length);
    });
});

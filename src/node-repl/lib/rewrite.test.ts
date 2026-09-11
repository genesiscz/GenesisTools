import { describe, expect, it } from "bun:test";
import { rewriteTurn } from "./rewrite";

describe("rewriteTurn", () => {
    it("turns let and const into assignments and returns the last expression", () => {
        const out = rewriteTurn("let z = await Promise.resolve(41);\nz + 1");
        expect(out).toContain("(async () => {");
        expect(out).toContain("\nz = await Promise.resolve(41);");
        expect(out).not.toContain("let z");
        expect(out).toContain("return (z + 1)");
    });

    it("parenthesises a destructuring assignment so it parses as a statement", () => {
        const out = rewriteTurn("const { p, q } = await load();\np + q");
        expect(out).toContain("({ p, q } = await load())");
        expect(out).toContain("return (p + q)");
    });

    it("hoists classes and functions onto globalThis so they survive the IIFE", () => {
        const out = rewriteTurn(
            "class Foo { m() { return 1; } }\nfunction greet(n) { return `hi ${n}`; }\nasync function later() { return 2; }\ngreet('x')"
        );
        // The transpiler reformats the source, so these name the shape, not the layout.
        expect(out).toContain("globalThis.Foo = class Foo {");
        expect(out).toContain("globalThis.greet = function greet(n) {");
        expect(out).toContain("globalThis.later = async function later() {");
        expect(out).toContain('return (greet("x"))');
    });

    it("accepts TypeScript and strips the types before rewriting", () => {
        const out = rewriteTurn("const n: number = 1;\ninterface Shape { w: number }\nn * 2");
        expect(out).not.toContain(": number");
        expect(out).not.toContain("interface");
        expect(out).toContain("return (n * 2)");
    });

    it("leaves a turn whose last statement is not an expression alone", () => {
        const out = rewriteTurn("if (true) { x = 1 }");
        expect(out).not.toContain("return (");
    });

    it("keeps a side-effect-free last expression, which the transpiler would otherwise drop", () => {
        expect(rewriteTurn("typeof marker")).toContain("return (typeof marker)");
        // constant folding is fine: the value is the same
        expect(rewriteTurn("1 + 1")).toContain("return (2)");
    });
});

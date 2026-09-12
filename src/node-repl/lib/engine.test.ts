import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { ReplEngine } from "./engine";

describe("ReplEngine", () => {
    const engine = new ReplEngine({ defaultTimeoutMs: 10_000 });

    afterAll(() => {
        engine.dispose();
    });

    it("keeps bindings across turns, redeclares them, and awaits at the top level", async () => {
        const first = await engine.run("let z = await Promise.resolve(41);\nz + 1");
        expect(first.ok).toBe(true);
        expect(first.text).toBe("42");

        const second = await engine.run("const z = await Promise.resolve(100);\nz");
        expect(second.text).toBe("100");

        const third = await engine.run(
            "class Foo { m() { return 2; } }\nfunction twice(n) { return n * 2; }\ntwice(new Foo().m())"
        );
        expect(third.text).toBe("4");

        const fourth = await engine.run("[typeof Foo, typeof twice, z]");
        expect(fourth.text).toContain('"function"');
        expect(fourth.text).toContain("100");
    });

    it("accepts TypeScript, collects nodeRepl.write, and returns the last expression", async () => {
        const result = await engine.run("const n: number = 3;\nnodeRepl.write('a');\nnodeRepl.write({ b: 1 });\nn * n");
        expect(result.ok).toBe(true);
        expect(result.text).toBe("a\n{\n  b: 1,\n}\n9");
    });

    it("reports a thrown error with the output produced before it", async () => {
        const result = await engine.run("nodeRepl.write('before');\nthrow new Error('boom')");
        expect(result.ok).toBe(false);
        expect(result.error).toBe("boom");
        expect(result.text).toBe("before");
    });

    it("emits images as base64 plus a file on disk", async () => {
        const result = await engine.run(
            "await nodeRepl.emitImage({ bytes: new Uint8Array([137, 80, 78, 71]), mimeType: 'image/png' });\n'done'"
        );
        expect(result.ok).toBe(true);
        expect(result.images).toHaveLength(1);
        expect(result.images[0].mimeType).toBe("image/png");
        expect(result.images[0].data).toBe(Buffer.from([137, 80, 78, 71]).toString("base64"));
        expect(result.images[0].path).toContain("node-repl-images-");
    });

    it("kills a turn that overruns, on the wall clock, and starts clean", async () => {
        await engine.run("globalThis.marker = 'alive'");
        const stuck = await engine.run("while (true) { await Promise.resolve(); }", 400);
        expect(stuck.ok).toBe(false);
        expect(stuck.error).toContain("exceeded 400 ms");
        const after = await engine.run("typeof marker");
        expect(after.ok).toBe(true);
        expect(after.text).toBe("undefined");
    });

    it("reset drops every binding", async () => {
        await engine.run("let keep = 1");
        engine.reset();
        const result = await engine.run("typeof keep");
        expect(result.text).toBe("undefined");
    });

    it("imports builtins, and a bare package from a registered directory", async () => {
        const builtin = await engine.run("const p = await import('node:path');\np.basename('/a/b.txt')");
        expect(builtin.text).toBe("b.txt");

        const dir = mkdtempSync(join(tmpdir(), "node-repl-pkg-"));
        mkdirSync(join(dir, "node_modules", "fakepkg"), { recursive: true });
        writeFileSync(
            join(dir, "node_modules", "fakepkg", "package.json"),
            SafeJSON.stringify({ name: "fakepkg", main: "index.js" })
        );
        writeFileSync(join(dir, "node_modules", "fakepkg", "index.js"), "module.exports = { answer: 7 };");
        const registered = await engine.addModuleDir(dir);
        expect(registered.ok).toBe(true);
        const imported = await engine.run("const m = await import('fakepkg');\nm.default?.answer ?? m.answer");
        expect(imported.ok).toBe(true);
        expect(imported.text).toBe("7");
    });
});

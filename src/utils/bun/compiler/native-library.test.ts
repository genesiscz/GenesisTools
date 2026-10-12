import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineNativeLibrary, ensureCompiled } from "./native-library";

const directory = mkdtempSync(join(tmpdir(), "bun-compiler-"));
const cacheDir = join(directory, "cache");
const source = join(directory, "add.c");
const symbols = { add: { args: ["i32", "i32"], returns: "i32" } } as const;
const hasCompiler = process.platform !== "win32" && (Bun.which("clang") ?? Bun.which("cc")) !== null;

writeFileSync(source, "int add(int a, int b) { return a + b; }\n");

afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
});

describe("bun compiler", () => {
    it.skipIf(!hasCompiler)("builds a source once per version and builds again only after an edit", () => {
        const first = ensureCompiled({ source, cacheDir });
        const again = ensureCompiled({ source, cacheDir });

        expect(first.built).toBe(true);
        expect(again).toEqual({ path: first.path, built: false });

        writeFileSync(source, "int add(int a, int b) { return b + a; }\n");
        const edited = ensureCompiled({ source, cacheDir });

        expect(edited.built).toBe(true);
        expect(edited.path).not.toBe(first.path);
    });

    it.skipIf(!hasCompiler)("loads the cached build and calls it", () => {
        const library = defineNativeLibrary({ source, cacheDir, symbols })();

        expect(library.via).toBe("cache");
        expect(library.symbols.add(2, 3)).toBe(5);
    });

    it("compiles with TinyCC in memory and writes no library", () => {
        const getter = defineNativeLibrary({ source, cacheDir: join(directory, "unused"), symbols, compiler: "tcc" });
        const library = getter();

        expect(library.via).toBe("tcc");
        expect(library.path).toBeUndefined();
        expect(library.symbols.add(20, 22)).toBe(42);
        expect(getter()).toBe(library);
    });
});

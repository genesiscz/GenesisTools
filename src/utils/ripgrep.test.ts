import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ripgrepBinary, vendoredRipgrep } from "./ripgrep";

describe("ripgrepBinary", () => {
    test("always resolves in this repo: PATH or the vendored claude-code copy", async () => {
        const rg = ripgrepBinary();
        expect(rg).not.toBeNull();

        const proc = Bun.spawn([rg as string, "--version"], { stdout: "pipe", stderr: "ignore" });
        const text = await new Response(proc.stdout).text();
        expect(await proc.exited).toBe(0);
        expect(text).toStartWith("ripgrep ");
    });

    test("the vendored fallback points at a real file for this platform", () => {
        const vendored = vendoredRipgrep();
        expect(vendored).not.toBeNull();
        expect(vendored).toContain(join("vendor", "ripgrep", `${process.arch}-${process.platform}`));
    });

    test("a root without node_modules yields null instead of a dead path", () => {
        expect(vendoredRipgrep(mkdtempSync(join(tmpdir(), "rg-root-")))).toBeNull();
    });
});

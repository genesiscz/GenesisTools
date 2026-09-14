import { describe, expect, test } from "bun:test";
import { ripgrepBinary } from "./ripgrep";

describe("ripgrepBinary", () => {
    test("resolves the rg on PATH, and it really runs", async () => {
        // CI installs ripgrep before the suite (.github/workflows/ci.yml). A machine without it
        // should fail here loudly rather than let callers degrade to a bare "rg" that is not there.
        const rg = ripgrepBinary();
        expect(rg).not.toBeNull();

        const proc = Bun.spawn([rg as string, "--version"], { env: process.env, stdout: "pipe", stderr: "ignore" });
        const text = await new Response(proc.stdout).text();
        expect(await proc.exited).toBe(0);
        expect(text).toStartWith("ripgrep ");
    });

    // There is deliberately no "returns null when rg is absent" control: `Bun.which` reads the
    // process's real PATH and ignores a mutated `process.env.PATH`, so such a test would pass for
    // the wrong reason or not at all. The null branch is Bun's contract, not this module's.
});

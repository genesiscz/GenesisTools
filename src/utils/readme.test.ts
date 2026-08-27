import { describe, expect, it, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { printReadmeAndExit } from "./readme";

/** Run printReadmeAndExit in a child process, whose stdout is a PIPE, never a TTY. */
async function readmeThroughAPipe(markdown: string): Promise<{ stdout: string; exitCode: number }> {
    const dir = mkdtempSync(join(tmpdir(), "readme-pipe-"));
    writeFileSync(join(dir, "README.md"), markdown);
    const script = join(dir, "run.ts");
    writeFileSync(
        script,
        `import { printReadmeAndExit } from ${SafeJSON.stringify(join(import.meta.dir, "readme.ts"))};\n` +
            `printReadmeAndExit(${SafeJSON.stringify(dir)});\n`
    );

    const proc = Bun.spawn([process.execPath, "run", script], { stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    rmSync(dir, { recursive: true, force: true });

    return { stdout, exitCode };
}

describe("printReadmeAndExit", () => {
    // Plan Task 12 asserted `handleReadme`; the real, 33-caller transitional
    // export is `handleReadmeFlag(importMetaUrl)` — assert that one is kept.
    it("is exported as a callable (prints + exits); handleReadmeFlag kept transitional", async () => {
        const mod = await import("./readme");
        expect(typeof printReadmeAndExit).toBe("function");
        expect(typeof (mod as Record<string, unknown>).handleReadmeFlag).toBe("function");
    });

    /**
     * The strip used to live here as a second `stripAnsi` pass over output the
     * renderer had just coloured. It is one `color` option now, so this pins the
     * OBSERVABLE contract rather than which line does the work.
     */
    test("a piped README carries no ANSI escapes", async () => {
        const { stdout, exitCode } = await readmeThroughAPipe("# Title\n\nSome **bold** text.\n\n- one\n- two\n");

        expect(exitCode).toBe(0);
        expect(stdout).toContain("Title");
        expect(stdout).toContain("bold");
        // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting the ABSENCE of ANSI escapes
        expect(stdout).not.toMatch(/\u001b\[/);
    });

    test("a missing README exits 1 and says so", async () => {
        const dir = mkdtempSync(join(tmpdir(), "readme-missing-"));
        const script = join(dir, "run.ts");
        writeFileSync(
            script,
            `import { printReadmeAndExit } from ${SafeJSON.stringify(join(import.meta.dir, "readme.ts"))};\n` +
                `printReadmeAndExit(${SafeJSON.stringify(dir)});\n`
        );

        const proc = Bun.spawn([process.execPath, "run", script], { stdout: "pipe", stderr: "pipe" });
        const stdout = await new Response(proc.stdout).text();
        const exitCode = await proc.exited;
        rmSync(dir, { recursive: true, force: true });

        expect(exitCode).toBe(1);
        expect(stdout).toContain("No README.md found");
    });
});

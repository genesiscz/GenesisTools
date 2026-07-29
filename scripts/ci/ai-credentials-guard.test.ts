import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GUARD = join(import.meta.dir, "ai-credentials-guard.sh");

async function runGuard(files: Record<string, string>): Promise<{ code: number; output: string }> {
    const root = mkdtempSync(join(tmpdir(), "creds-guard-"));
    mkdirSync(root, { recursive: true });

    for (const [name, contents] of Object.entries(files)) {
        writeFileSync(join(root, name), contents);
    }

    const proc = Bun.spawn(["bash", GUARD, root], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);

    return { code, output: stdout + stderr };
}

describe("argless provider factories", () => {
    /**
     * Every one of these performs the same unauditable env read. The guard used
     * to require a `=` or `return` immediately before the call, so only the first
     * was caught and the rest shipped.
     */
    const bypasses: Record<string, string> = {
        assignment: "const p = createOpenAI();",
        returned: "function f() { return createGroq(); }",
        argument: "consume(createOpenAI());",
        parenthesised: "const p = (createOpenAI());",
        statement: "createAnthropic();",
        awaited: "const p = await createGoogleGenerativeAI();",
        chained: "const m = createOpenAI().languageModel('gpt-4o');",
    };

    for (const [form, source] of Object.entries(bypasses)) {
        test(`rejects the ${form} form`, async () => {
            const { code, output } = await runGuard({ "offender.ts": source });

            expect(code).toBe(1);
            expect(output).toContain("argless provider factory");
        });
    }

    test("accepts a factory called with an explicit key", async () => {
        const { code } = await runGuard({
            "good.ts": "const p = createOpenAI({ apiKey });\nconst q = createGroq({ apiKey, baseURL });\n",
        });

        expect(code).toBe(0);
    });

    /**
     * The prefix the old regex used was really a way to skip prose that NAMES the
     * pattern. Dropping it means prose has to be skipped directly, and these are
     * the shapes it takes in this repo.
     */
    test("ignores prose that only names the pattern", async () => {
        const { code } = await runGuard({
            "doc.ts": [
                "// an argless createOpenAI() reads the key from its own env var",
                " * `createGroq()` is banned for the same reason",
                "# createAnthropic() in a shell comment",
                "const explained = `createOpenAI() is what we do not do`;",
            ].join("\n"),
        });

        expect(code).toBe(0);
    });
});

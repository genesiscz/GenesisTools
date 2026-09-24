import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GUARD = join(import.meta.dir, "ai-credentials-guard.sh");

async function runGuard(files: Record<string, string>): Promise<{ code: number; output: string }> {
    const root = mkdtempSync(join(tmpdir(), "creds-guard-"));
    mkdirSync(root, { recursive: true });

    for (const [name, contents] of Object.entries(files)) {
        writeFileSync(join(root, name), contents);
    }

    const proc = Bun.spawn(["bash", GUARD, root], { env: process.env, stdout: "pipe", stderr: "pipe" });
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

/**
 * Regression test: PR #330 review t40. `scan()` ran `cd "$root" && git grep …`
 * and read the combined status, so a failed `cd` produced bash's exit 1, which
 * is git grep's "no match" — the guard printed OK having scanned nothing. That
 * is the silent-pass shape this guard was converted to eliminate.
 */
describe("unscannable roots", () => {
    async function runGuardOnRoot(root: string): Promise<{ code: number; output: string }> {
        const proc = Bun.spawn(["bash", GUARD, root], { env: process.env, stdout: "pipe", stderr: "pipe" });
        const [stdout, stderr, code] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
        ]);

        return { code, output: stdout + stderr };
    }

    test("a root that does not exist fails the guard instead of reporting OK", async () => {
        const { code, output } = await runGuardOnRoot(join(tmpdir(), "creds-guard-absent-00000000"));

        expect(code).toBe(1);
        expect(output).not.toContain("ai-credentials-guard: OK");
    });

    test("a root that cannot be entered is diagnosed as that, not as a credential violation", async () => {
        // `if ! cd "$root" 2>&1` merged bash's "Permission denied" into scan's
        // STDOUT, and rule 1 reads scan through a command substitution — so the
        // permission message was captured as a match and reported as an argless
        // provider factory. `exit 1` inside that substitution also only killed
        // the subshell, so the guard carried on scanning after the failure.
        const dir = mkdtempSync(join(tmpdir(), "creds-guard-perm-"));
        const locked = join(dir, "locked");
        mkdirSync(locked);
        chmodSync(locked, 0o000);

        try {
            const { code, output } = await runGuardOnRoot(locked);

            expect(code).toBe(1);
            expect(output).not.toContain("ai-credentials-guard: OK");
            expect(output).toContain("cannot be entered");
            expect(output).not.toContain("argless provider factory");
        } finally {
            chmodSync(locked, 0o755);
        }
    });

    test("a root that is a file, not a directory, also fails", async () => {
        const dir = mkdtempSync(join(tmpdir(), "creds-guard-file-"));
        const file = join(dir, "not-a-dir.ts");
        writeFileSync(file, "const p = createOpenAI({ apiKey });\n");

        const { code, output } = await runGuardOnRoot(file);

        expect(code).toBe(1);
        expect(output).not.toContain("ai-credentials-guard: OK");
    });
});

/**
 * Rule 3 used to match the literal inside PROSE. On 2026-09-20 one JSDoc line in
 * `src/utils/ai/evaluation/auth.ts` failed this guard on every branch in the repo,
 * including master, and CLAUDE.md already recorded the gap. The pair below is what makes
 * the fix honest: the comment passes AND the real call still fails.
 */
describe("the one ai-config writer", () => {
    test("a comment that merely names the literal does not trip it", async () => {
        const { code, output } = await runGuard({
            "prose.ts": [
                "/**",
                ' * This guard exists because of the literal `new Storage("ai")` call.',
                " */",
                '// new Storage("ai") would be wrong here, which is the point',
                "export const note = 1;",
            ].join("\n"),
        });

        expect(output).not.toContain("outside src/utils/ai/config/");
        expect(code).toBe(0);
    });

    test("the real call is still caught", async () => {
        const { code, output } = await runGuard({
            "writer.ts": [
                'import { Storage } from "@genesiscz/utils/storage/storage";',
                'const s = new Storage("ai");',
            ].join("\n"),
        });

        expect(output).toContain("outside src/utils/ai/config/");
        expect(code).toBe(1);
    });

    test("a trailing comment on a real call is still caught", async () => {
        const { code } = await runGuard({ "writer.ts": 'const s = new Storage("ai"); // deliberate' });

        expect(code).toBe(1);
    });

    /**
     * The inverse control. A `^(?!\s*(?://|\*|/\*))` prefix was tried first and rejected the
     * whole LINE, so a real call after a closed block comment passed the guard. The filter
     * now looks only at the line's leading marker, which is why these still fail.
     */
    test("a real call after a closed block comment on the same line is still caught", async () => {
        const { code, output } = await runGuard({ "writer.ts": '/* keep */ const s = new Storage("ai");' });

        expect(output).toContain("outside src/utils/ai/config/");
        expect(code).toBe(1);
    });

    test("a real call indented after a closed block comment is still caught", async () => {
        const { code } = await runGuard({ "writer.ts": '    /* keep */ new Storage("ai");' });

        expect(code).toBe(1);
    });

    test("a real call followed by a colon and a comment later in the line is still caught", async () => {
        const { code } = await runGuard({ "writer.ts": 'const s = flag ? new Storage("ai") : // none\n    null;' });

        expect(code).toBe(1);
    });

    test("a private-field writer is still caught, although its line starts with #", async () => {
        const { code } = await runGuard({ "writer.ts": 'class Keeper {\n    #store = new Storage("ai");\n}\n' });

        expect(code).toBe(1);
    });

    test("a JSDoc continuation line naming it still passes", async () => {
        const { code } = await runGuard({ "prose.ts": ' * see `new Storage("ai")` for why\nexport const x = 1;' });

        expect(code).toBe(0);
    });
});

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHECK = join(import.meta.dir, "placeholder-check.sh");

/**
 * Every marker in this file is invented. The check reads its list from outside
 * the repository precisely so that no real value has to be written down here,
 * and a fixture that planted real ones would put them straight back.
 */
const MARKERS = [
    "real name\t\\bWile E\\. Coyote\\b",
    "internal host\tacme-corp\\.example",
    "tenant id\t11111111-",
    "# a comment line, ignored",
    "",
    "roadrunner-industries",
].join("\n");

/**
 * Throw on a failed setup command instead of letting the fixture be a plain
 * directory. A silent `git init` failure leaves the check with nothing to scan,
 * and the assertion that follows blames the check for the harness's problem.
 */
async function git(cwd: string, args: string[]): Promise<void> {
    const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);

    if (code !== 0) {
        throw new Error(`test fixture setup failed: git ${args.join(" ")} exited ${code}: ${stderr.trim()}`);
    }
}

/**
 * The check reads TRACKED files via `git grep`, so the fixture has to be a real
 * repository with the files staged. A plain temp directory would make every
 * scan return empty and the check would pass having read nothing — the exact
 * silent-pass failure `require-grep.sh` exists to prevent.
 */
async function run(
    files: Record<string, string>,
    { asRepo = true, markers = MARKERS }: { asRepo?: boolean; markers?: string | null } = {}
): Promise<{ code: number; output: string }> {
    const root = mkdtempSync(join(tmpdir(), "placeholder-check-"));

    for (const [name, contents] of Object.entries(files)) {
        writeFileSync(join(root, name), contents);
    }

    if (asRepo) {
        await git(root, ["init", "-q"]);
        await git(root, ["add", "-A"]);
    }

    const env: Record<string, string> = { ...process.env };

    if (markers === null) {
        // Point HOME at an empty directory so the default marker path cannot
        // resolve to the developer's real list and make this test lie.
        env.HOME = mkdtempSync(join(tmpdir(), "placeholder-home-"));
        delete env.PLACEHOLDER_MARKERS_FILE;
    } else {
        const file = join(mkdtempSync(join(tmpdir(), "placeholder-markers-")), "markers.txt");
        writeFileSync(file, `${markers}\n`);
        env.PLACEHOLDER_MARKERS_FILE = file;
    }

    const proc = Bun.spawn(["bash", CHECK, root], { env, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);

    return { code, output: stdout + stderr };
}

describe("placeholder check", () => {
    const offenders: Record<string, { file: string; contents: string }> = {
        "a name": { file: "notes.md", contents: "Reviewed with Wile E. Coyote on Tuesday.\n" },
        "a host": { file: "fixture.ts", contents: 'const base = "https://acme-corp.example/api";\n' },
        "a tenant id": { file: "ids.ts", contents: 'const id = "11111111-0000-0000-0000-000000000000";\n' },
        "a tab-less entry": { file: "readme.md", contents: "Cloned from roadrunner-industries/tools.\n" },
    };

    for (const [what, offender] of Object.entries(offenders)) {
        test(`catches ${what}`, async () => {
            const { code, output } = await run({ [offender.file]: offender.contents });

            expect(code).toBe(1);
            expect(output).toContain(offender.file);
        });
    }

    test("catches a value whose case differs from the pattern", async () => {
        const { code, output } = await run({ "cased.md": "Ping WILE E. COYOTE about the fixture.\n" });

        expect(code).toBe(1);
        expect(output).toContain("cased.md");
    });

    test("scans the check's own sources too, with no carve-out", async () => {
        const { code, output } = await run({
            "scripts.sh": "# acme-corp.example was the old host\n",
        });

        expect(code).toBe(1);
        expect(output).toContain("scripts.sh");
    });

    test("passes on a tree that uses placeholders", async () => {
        const { code, output } = await run({
            "notes.md": [
                "Reviewed with Jane Doe on Tuesday.",
                'const base = "https://api.example.com";',
                'const id = "00000000-0000-0000-0000-000000000000";',
                "Cloned from example-org/tools.",
                "",
            ].join("\n"),
        });

        expect(code).toBe(0);
        expect(output).toContain("no matches in tracked files");
    });

    /**
     * A check that cannot scan must say so. Reporting "clean" when no list was
     * supplied is worse than not running at all, because it looks like proof.
     */
    test("reports plainly when no list is configured instead of claiming clean", async () => {
        const { code, output } = await run({ "leak.md": "Wile E. Coyote\n" }, { markers: null });

        expect(code).toBe(0);
        expect(output).toContain("not configured, nothing scanned");
        expect(output).not.toContain("no matches in tracked files");
    });

    test("fails when the list exists but holds no usable entry", async () => {
        const { code, output } = await run({ "leak.md": "Wile E. Coyote\n" }, { markers: "# only a comment" });

        expect(code).toBe(1);
        expect(output).toContain("no usable entries");
    });

    /**
     * The scan is ONE `git grep` over every needle, so nothing below can differ
     * from a per-needle loop unless more than one needle is in play. These are
     * the cases that loop never had to get right.
     */
    test("names every needle that fired when two match in different files", async () => {
        const { code, output } = await run({
            "a.md": "met Wile E. Coyote on Tuesday\n",
            "b.ts": 'const base = "https://acme-corp.example/api";\n',
        });

        expect(code).toBe(1);
        expect(output).toContain("2 line(s) in 2 tracked file(s)");
        expect(output).toContain("needle(s): real name, internal host");
        expect(output).toContain("a.md:1:");
        expect(output).toContain("b.ts:1:");
    });

    test("prints a line once and names both needles when two match the same line", async () => {
        const { code, output } = await run({ "a.md": "Wile E. Coyote @ acme-corp.example\n" });

        expect(code).toBe(1);
        expect(output).toContain("1 line(s) in 1 tracked file(s)");
        expect(output).toContain("needle(s): real name, internal host");
        expect(output.split("a.md:1:").length - 1).toBe(1);
    });

    /**
     * An empty pattern must not be counted as a scan that happened. `git grep -f`
     * would drop it silently; `-e ""` would match every line in the tree. Both
     * make the count lie, in opposite directions.
     */
    test("skips an empty pattern by name and leaves it out of the count", async () => {
        const markers = ["real name\t\\bWile E\\. Coyote\\b", "empty one\t", "trailing tab\t"].join("\n");
        const { code, output } = await run({ "notes.md": "Reviewed with Jane Doe.\n" }, { markers });

        expect(code).toBe(0);
        expect(output).toContain("'empty one': empty pattern, skipped");
        expect(output).toContain("'trailing tab': empty pattern, skipped");
        expect(output).toContain("1 pattern(s) checked, no matches in tracked files (2 empty pattern(s) skipped)");
    });

    test("a list of only empty patterns counts as no usable entry", async () => {
        const { code, output } = await run({ "leak.md": "Wile E. Coyote\n" }, { markers: "a\t\nb\t" });

        expect(code).toBe(1);
        expect(output).toContain("no usable entries");
        expect(output).not.toContain("no matches in tracked files");
    });

    /**
     * A broken scan must exit ABOVE 1 (1 means "a hit") and must say which
     * needle broke it, by label — with hundreds of harvested needles, a line
     * number into a filtered temp file is not an answer.
     */
    test("a pattern that will not compile exits above 1 and is named by its label", async () => {
        const markers = ["good\tclean", "broken one\t[unclosed", "also fine\tx"].join("\n");
        const { code, output } = await run({ "notes.md": "nothing here\n" }, { markers });

        expect(code).toBeGreaterThan(1);
        expect(output).toContain("this check checked nothing");
        expect(output).toContain("do not compile as PCRE");
        expect(output).toContain("    broken one");
        expect(output).not.toContain("    good");
        expect(output).not.toContain("    also fine");
    });

    /**
     * Pre-push budget. A per-needle loop costs ~7 ms of process start per
     * needle, so 800 needles alone would take ~5.6 s even on this tiny fixture;
     * the single-pass scan finishes in a fraction of a second. The bound is
     * loose on purpose so a busy machine does not flake it.
     */
    test("800 needles finish inside the 3 s pre-push budget", async () => {
        const markers = Array.from({ length: 800 }, (_, i) => `needle ${i}\tplaceholder-needle-${i}-\\d+`).join("\n");
        const started = performance.now();
        const { code, output } = await run({ "notes.md": "Reviewed with Jane Doe.\n" }, { markers });
        const elapsedMs = performance.now() - started;

        expect(code).toBe(0);
        expect(output).toContain("800 pattern(s) checked");
        expect(elapsedMs).toBeLessThan(3000);
    });

    test("refuses to run outside a git work tree rather than reporting clean", async () => {
        const { code, output } = await run({ "leak.md": "Wile E. Coyote\n" }, { asRepo: false });

        expect(code).not.toBe(0);
        expect(output).toContain("not inside a git work tree");
    });
});

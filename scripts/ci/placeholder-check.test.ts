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

    test("refuses to run outside a git work tree rather than reporting clean", async () => {
        const { code, output } = await run({ "leak.md": "Wile E. Coyote\n" }, { asRepo: false });

        expect(code).not.toBe(0);
        expect(output).toContain("not inside a git work tree");
    });
});

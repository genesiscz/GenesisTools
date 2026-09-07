import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const PRELOAD = resolve(import.meta.dir, "preload-test-tmpdir.ts");

/**
 * The preload cannot be imported here (it runs before any test module loads, and a second
 * import would install a second root), so the first test asserts the invariants it
 * maintains from inside a process it already configured, and the second drives a child
 * `bun test` with the preload on a scratch suite to watch what happens at exit.
 */
describe("test tmpdir preload", () => {
    test("this process's temp dir is a private gt-test-tmp root, and the sandbox home lives inside it", () => {
        expect(basename(tmpdir())).toStartWith("gt-test-tmp-");
        expect(process.env.GENESIS_TOOLS_HOME?.startsWith(tmpdir())).toBe(true);
    });

    test("a run removes its root, green or red, and stale siblings are swept", () => {
        const parent = mkdtempSync(join(tmpdir(), "tmpdir-preload-parent-"));
        const suite = mkdtempSync(join(tmpdir(), "tmpdir-preload-suite-"));
        writeFileSync(
            join(suite, "green.test.ts"),
            [
                'import { expect, test } from "bun:test";',
                'import { mkdtempSync } from "node:fs";',
                'import { tmpdir } from "node:os";',
                'import { join } from "node:path";',
                'test("fixtures land in the root", () => {',
                '    expect(mkdtempSync(join(tmpdir(), "fixture-"))).toContain("gt-test-tmp-");',
                "});",
                "",
            ].join("\n")
        );
        writeFileSync(
            join(suite, "red.test.ts"),
            [
                'import { expect, test } from "bun:test";',
                'test("fails on purpose", () => {',
                "    expect(1).toBe(2);",
                "});",
                "",
            ].join("\n")
        );
        const stale = join(parent, "gt-test-tmp-stale");
        const young = join(parent, "gt-test-tmp-young");
        mkdirSync(stale);
        mkdirSync(young);
        const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60 * 1000);
        utimesSync(stale, sevenHoursAgo, sevenHoursAgo);

        const run = (file: string) =>
            spawnSync("bun", ["test", "--preload", PRELOAD, file], {
                cwd: suite,
                encoding: "utf8",
                env: { ...process.env, TMPDIR: parent, TMP: parent, TEMP: parent },
            });

        const green = run("green.test.ts");
        if (green.status !== 0) {
            console.error(green.stdout, green.stderr);
        }
        expect(green.status).toBe(0);
        expect(readdirSync(parent).filter((name) => name.startsWith("gt-test-tmp-"))).toEqual(["gt-test-tmp-young"]);

        const red = run("red.test.ts");
        expect(red.status).not.toBe(0);
        expect(readdirSync(parent).filter((name) => name.startsWith("gt-test-tmp-"))).toEqual(["gt-test-tmp-young"]);
    });
});

import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { skip } from "@app/utils/test/skip";

const TOOLS_BIN = join(import.meta.dir, "../../tools");

describe("tools launcher verbose flag", () => {
    // Global `--verbose` on nested subcommands needs addGlobalVerboseOption
    // (src/utils/cli/commander.ts, added 586de2f1c) wired into every tool's
    // Command — that migration is in progress (macos/* not adopted yet), so
    // this case is opt-in via RUN_WIP_E2E=1 until it lands.
    it.skipIf(skip.wip)("allows --verbose after nested subcommands", async () => {
        const proc = Bun.spawn([TOOLS_BIN, "macos", "mail", "search", "--verbose"], {
            stdout: "pipe",
            stderr: "pipe",
        });

        const [stdout, stderr, exitCode] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
        ]);
        const output = `${stdout}\n${stderr}`;

        expect(exitCode).not.toBe(0);
        expect(output).not.toContain("unknown option '--verbose'");
        expect(output).toContain("missing required argument");
    });

    it("preserves --verbose for tools that declare it", async () => {
        const proc = Bun.spawn([TOOLS_BIN, "json", "--verbose"], {
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
        });

        proc.stdin.write('{"a":1}');
        proc.stdin.end();

        const [stdout, stderr, exitCode] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
        ]);

        expect(exitCode).toBe(0);
        expect(stdout).toContain("a: 1");
        expect(stderr).toContain("Compact JSON size");
    });
});

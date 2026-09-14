import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shellCommandLine, shellQuote } from "./quote";

/**
 * The assertions run the quoted string through a REAL `sh -c`, because that is
 * what consumes it (`src/daemon/lib/runner.ts` spawns `["sh", "-c", command]`).
 * Comparing quoted strings to expected strings would only restate the
 * implementation; comparing the argv `sh` produces measures the thing that broke.
 */
async function argvFrom(command: string): Promise<string[]> {
    const proc = Bun.spawn(["sh", "-c", `printf '%s\\n' ${command}`], {
        stdout: "pipe",
        stderr: "pipe",
        env: process.env,
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    // `printf '%s\n'` writes a trailing newline per argument, so the last split
    // element is always "". Dropping only that one keeps an EMPTY argument visible.
    return stdout.split("\n").slice(0, -1);
}

describe("shellQuote", () => {
    test("a path with spaces survives as ONE argument", async () => {
        expect(await argvFrom(shellQuote("/Users/dev/My Projects/poll.ts"))).toEqual([
            "/Users/dev/My Projects/poll.ts",
        ]);
    });

    test("NEGATIVE CONTROL: the same path unquoted splits into three", async () => {
        expect(await argvFrom("/Users/dev/My Projects/poll.ts")).toEqual(["/Users/dev/My", "Projects/poll.ts"]);
    });

    test("shell metacharacters stay literal instead of being interpreted", async () => {
        const nasty = "/tmp/a;rm -rf $HOME/`whoami`/x*.ts";

        expect(await argvFrom(shellQuote(nasty))).toEqual([nasty]);
    });

    test("a single quote inside the value is escaped rather than ending the quoting", async () => {
        expect(await argvFrom(shellQuote("/tmp/it's here/poll.ts"))).toEqual(["/tmp/it's here/poll.ts"]);
    });

    test("an empty value stays an argument instead of vanishing", async () => {
        expect(await argvFrom(`${shellQuote("")} x`)).toEqual(["", "x"]);
    });
});

describe("shellCommandLine", () => {
    test("every element is quoted and the argv comes back whole", async () => {
        const argv = ["/opt/my bun/bin/bun", "run", "/Users/dev/My Projects/poll.ts"];

        expect(await argvFrom(shellCommandLine(argv))).toEqual(argv);
    });
});

/**
 * The values quoted by the claude launchers are OAuth tokens, account names and cwd
 * paths that end up inside `sh -c` strings, so the property that matters is that a real
 * shell hands the original string back unchanged and runs nothing extra. The payloads
 * really do run `touch ./INJECTED` if quoting regresses, so each probe gets its own empty
 * temp dir as cwd; `stray` reports anything the shell created. (Moved here from the
 * deleted `src/claude/lib/shell-quote.test.ts`, PR #383 review.)
 */
function throughShell(value: string): { seen: string; marker: boolean; stray: string[] } {
    const dir = mkdtempSync(join(tmpdir(), "shell-quote-probe-"));

    try {
        const probe = Bun.spawnSync(["/bin/sh", "-c", `printf %s ${shellQuote(value)}; test ! -e ./INJECTED`], {
            env: process.env,
            cwd: dir,
            stdout: "pipe",
            stderr: "pipe",
        });

        return { seen: probe.stdout.toString(), marker: probe.exitCode === 0, stray: readdirSync(dir) };
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

describe("shellQuote survives a real shell", () => {
    const cases: Array<[string, string]> = [
        ["plain", "claude-fable-5"],
        ["empty", ""],
        ["spaces", "My Project Dir"],
        ["single quote", "it's mine"],
        ["adjacent quotes", "''"],
        ["double quotes", `say "hi"`],
        ["command substitution", "$(touch ./INJECTED)"],
        ["backticks", "`touch ./INJECTED`"],
        ["variable expansion", "$HOME/$USER"],
        ["statement separator", "x; touch ./INJECTED"],
        ["pipe and redirect", "a | b > ./INJECTED"],
        ["background and glob", "a & b *"],
        ["newline", "line1\nline2"],
        ["backslashes", "a\\b\\\\c"],
        ["token-shaped", "sk-ant-oat01-AbC_1-2"],
        ["path with quote", "/Users/o'brien/Projects/app"],
    ];

    for (const [label, value] of cases) {
        test(`${label} round-trips byte-for-byte and executes nothing`, () => {
            const { seen, marker, stray } = throughShell(value);

            expect(seen).toBe(value);
            expect(marker).toBe(true);
            // The probe dir started empty; anything here was created by the shell.
            expect(stray).toEqual([]);
        });
    }

    test("every quote in a value is escaped, not just the first", () => {
        expect(shellQuote("'a'b'")).toBe(`''\\''a'\\''b'\\'''`);
    });
});

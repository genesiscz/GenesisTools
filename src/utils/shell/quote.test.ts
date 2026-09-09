import { describe, expect, test } from "bun:test";
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

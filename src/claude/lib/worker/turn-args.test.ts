import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shellSingleQuote } from "@app/claude/lib/shell-quote";
import { env } from "@genesiscz/utils/env";
import { spawnWorker, turnArgs } from "./worker";

describe("turnArgs", () => {
    test("`-p` is followed by a flag, never by a positional prompt", () => {
        // A positional prompt is an argv element, and argv is readable by every
        // local user through `ps`. The prompt goes in on stdin instead.
        const args = turnArgs({
            meta: { sessionId: "11111111-aaaa-bbbb-cccc-000000000001", model: "opus" },
            first: true,
            safeMode: true,
        });

        expect(args[args.indexOf("-p") + 1]).toBe("--output-format");
    });

    test("the first turn creates the session and later turns resume it", () => {
        const meta = { sessionId: "11111111-aaaa-bbbb-cccc-000000000002" };

        expect(turnArgs({ meta, first: true })).toContain("--session-id");
        expect(turnArgs({ meta, first: false })).toContain("--resume");
    });

    test("model and safe mode are forwarded only when set", () => {
        const meta = { sessionId: "11111111-aaaa-bbbb-cccc-000000000003", model: "sonnet" };

        expect(turnArgs({ meta, first: true, safeMode: true })).toEqual([
            "-p",
            "--output-format",
            "stream-json",
            "--verbose",
            "--session-id",
            meta.sessionId,
            "--model",
            "sonnet",
            "--safe-mode",
        ]);
        expect(turnArgs({ meta: { sessionId: meta.sessionId }, first: true })).not.toContain("--safe-mode");
    });
});

// The prompt used to be `args[1]`, so `ps` showed it to every local user for
// the whole turn — and the code's own comment says it can carry credentials or
// private code. This drives the real spawn against a fake `claude` that records
// what it was given.
describe.skipIf(process.platform === "win32")("spawnWorker delivers the prompt on stdin", () => {
    test("the child sees the prompt on stdin and never in its argv", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-claude-worker-spawn-"));
        const bin = join(home, ".bun", "bin");
        mkdirSync(bin, { recursive: true });

        const argvPath = join(home, "argv.txt");
        const stdinPath = join(home, "stdin.txt");
        const fake = join(bin, "claude");
        writeFileSync(
            fake,
            `#!/bin/sh\nprintf '%s\\n' "$@" > ${shellSingleQuote(argvPath)}\ncat > ${shellSingleQuote(stdinPath)}\n`,
            { mode: 0o755 }
        );
        chmodSync(fake, 0o755);

        const prompt = "review the patch, the login uses sk-fixture-not-a-real-secret";

        await env.testing.withOverrides({ HOME: home, GENESIS_TOOLS_HOME: home }, async () => {
            const result = await spawnWorker({
                name: "reviewer",
                account: { name: "work", token: "fixture-token" },
                cwd: home,
                prompt,
            });

            expect(result.exitCode).toBe(0);
        });

        const argv = readFileSync(argvPath, "utf8");
        expect(argv).not.toContain(prompt);
        expect(argv).not.toContain("sk-fixture-not-a-real-secret");
        expect(argv.split("\n").filter(Boolean)).toEqual([
            "-p",
            "--output-format",
            "stream-json",
            "--verbose",
            "--session-id",
            expect.stringMatching(/^[0-9a-f-]{36}$/),
        ]);
        expect(readFileSync(stdinPath, "utf8")).toBe(prompt);
    });
});

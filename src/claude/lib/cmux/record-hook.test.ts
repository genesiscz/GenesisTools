import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionPin } from "@app/claude/lib/cmux/types";
import { findProjectRoot } from "@genesiscz/utils/fs/project-root";
import { SafeJSON } from "@genesiscz/utils/json";

/**
 * The pin journal is written by a standalone hook script in the plugin (it cannot import
 * anything from src/), so the only honest test is to run it the way Claude Code does:
 * a real process, payload on stdin, and assert on the file it leaves behind.
 */
const HOOK = join(
    findProjectRoot(import.meta.dir) ?? process.cwd(),
    "plugins/genesis-tools/hooks/record-session-account.ts"
);

let home: string;

async function runHook(payload: string, env: Record<string, string> = {}): Promise<number> {
    const proc = Bun.spawn(["bun", HOOK], {
        stdin: new TextEncoder().encode(payload),
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, GENESIS_TOOLS_HOME: home, TOOLS_CLAUDE_ACCOUNT: "", CMUX_WORKSPACE_ID: "", ...env },
    });

    return await proc.exited;
}

async function readPins(): Promise<SessionPin[]> {
    const text = await readFile(join(home, ".genesis-tools", "claude-code", "session-pins.jsonl"), "utf8");

    return text
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => SafeJSON.parse(line, { strict: true }) as SessionPin);
}

beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "record-hook-"));
});

afterEach(async () => {
    await rm(home, { recursive: true, force: true });
});

describe("record-session-account hook", () => {
    test("records the pinned account for a session", async () => {
        const code = await runHook('{"session_id":"abc","cwd":"/tmp/project","source":"startup"}', {
            TOOLS_CLAUDE_ACCOUNT: "max-primary",
            CMUX_WORKSPACE_ID: "7D16C03C",
        });

        expect(code).toBe(0);
        expect(await readPins()).toEqual([
            expect.objectContaining({
                sessionId: "abc",
                account: "max-primary",
                cwd: "/tmp/project",
                workspaceId: "7D16C03C",
                source: "hook",
            }),
        ]);
    });

    test("an unpinned (keychain) session records a null account, not a missing row", async () => {
        await runHook('{"session_id":"abc","cwd":"/tmp/project"}');

        const pins = await readPins();

        expect(pins).toHaveLength(1);
        expect(pins[0].account).toBeNull();
        expect(pins[0].auth).toBe("keychain");
        expect(pins[0].authSource).toBe("default-bare");
    });

    test("a named account without CLAUDE_CODE_OAUTH_TOKEN is still a token launch", async () => {
        // Claude Code strips the OAuth token from hook children. Inferring
        // keychain from its absence marked every `tools claude start <account>`
        // session as --keychain and resumed them on the wrong credential.
        await runHook('{"session_id":"abc","cwd":"/tmp"}', { TOOLS_CLAUDE_ACCOUNT: "work" });

        expect(await readPins()).toEqual([
            expect.objectContaining({
                account: "work",
                auth: "token",
                authSource: "default-named",
            }),
        ]);
    });

    test("TOOLS_CLAUDE_AUTH=keychain wins even when an OAuth token is in the env", async () => {
        await runHook('{"session_id":"abc","cwd":"/tmp"}', {
            TOOLS_CLAUDE_ACCOUNT: "work",
            TOOLS_CLAUDE_AUTH: "keychain",
            CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-should-not-matter",
        });

        expect((await readPins())[0]).toEqual(
            expect.objectContaining({ auth: "keychain", authSource: "launch-env" })
        );
    });

    test("TOOLS_CLAUDE_AUTH=token wins when the OAuth token was stripped", async () => {
        await runHook('{"session_id":"abc","cwd":"/tmp"}', {
            TOOLS_CLAUDE_ACCOUNT: "work",
            TOOLS_CLAUDE_AUTH: "token",
        });

        expect((await readPins())[0]).toEqual(
            expect.objectContaining({ auth: "token", authSource: "launch-env" })
        );
    });

    test("appends, so a resumed session re-pins without losing history", async () => {
        await runHook('{"session_id":"abc","cwd":"/tmp"}', { TOOLS_CLAUDE_ACCOUNT: "first" });
        await runHook('{"session_id":"abc","cwd":"/tmp"}', { TOOLS_CLAUDE_ACCOUNT: "second" });

        expect((await readPins()).map((p) => p.account)).toEqual(["first", "second"]);
    });

    test("a payload with no session id writes nothing and still exits 0", async () => {
        expect(await runHook('{"cwd":"/tmp"}')).toBe(0);
        expect(await runHook("not json")).toBe(0);
        expect(await runHook("")).toBe(0);
        expect(readPins()).rejects.toThrow();
    });

    test("prints nothing — SessionStart stdout is injected into the session as context", async () => {
        const proc = Bun.spawn(["bun", HOOK], {
            stdin: new TextEncoder().encode('{"session_id":"abc","cwd":"/tmp"}'),
            stdout: "pipe",
            stderr: "pipe",
            env: { ...process.env, GENESIS_TOOLS_HOME: home },
        });
        const [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

        expect(stdout).toBe("");
    });
});

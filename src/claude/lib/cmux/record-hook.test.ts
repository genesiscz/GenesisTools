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
        // Every variable resolveAuth reads is neutralised, not just the two that
        // used to be: a developer whose own shell was launched by `tools claude
        // start` has CLAUDE_CODE_OAUTH_TOKEN and TOOLS_CLAUDE_AUTH set, and they
        // would leak in and silently flip the default-bare / default-named
        // expectations to "oauth-env" (PR #343 review t6).
        env: {
            ...process.env,
            GENESIS_TOOLS_HOME: home,
            TOOLS_CLAUDE_ACCOUNT: "",
            TOOLS_CLAUDE_AUTH: "",
            // Every harness's variable, not just Claude's: this suite runs inside whichever
            // agent the developer launched it from, and an inherited TOOLS_CODEX_ACCOUNT would
            // make the "never captures another harness's account" test pass for free.
            TOOLS_CODEX_ACCOUNT: "",
            TOOLS_GROK_ACCOUNT: "",
            CLAUDE_CODE_OAUTH_TOKEN: "",
            CMUX_WORKSPACE_ID: "",
            ...env,
        },
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

        expect((await readPins())[0]).toEqual(expect.objectContaining({ auth: "keychain", authSource: "launch-env" }));
    });

    test("TOOLS_CLAUDE_AUTH=token wins when the OAuth token was stripped", async () => {
        await runHook('{"session_id":"abc","cwd":"/tmp"}', {
            TOOLS_CLAUDE_ACCOUNT: "work",
            TOOLS_CLAUDE_AUTH: "token",
        });

        expect((await readPins())[0]).toEqual(expect.objectContaining({ auth: "token", authSource: "launch-env" }));
    });

    test("a bare OAuth token in the env is a token launch attributed to the env", async () => {
        // The one resolveAuth branch the suite did not reach (review t6). It only
        // fires when TOOLS_CLAUDE_AUTH is absent, so a launch that predates
        // `tools claude start` setting it is still recorded correctly.
        await runHook('{"session_id":"abc","cwd":"/tmp"}', {
            CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-from-the-environment",
        });

        expect((await readPins())[0]).toEqual(
            expect.objectContaining({ account: null, auth: "token", authSource: "oauth-env" })
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
describe("the harness decides which account variable is read", () => {
    const CODEX_TRANSCRIPT =
        "/Users/u/.codex/sessions/2026/09/10/rollout-2026-09-10T22-56-02-01a08d1b-296d-73f2-9e9c-a5d515cbc1ae.jsonl";

    test("a codex session records its own account, and is tagged codex", async () => {
        const code = await runHook(
            SafeJSON.stringify({
                session_id: "01a08d1b-296d-73f2-9e9c-a5d515cbc1ae",
                cwd: "/repo",
                transcript_path: CODEX_TRANSCRIPT,
            }),
            { TOOLS_CODEX_ACCOUNT: "work" }
        );

        expect(code).toBe(0);
        const [pin] = await readPins();
        expect(pin).toMatchObject({ provider: "codex", account: "work" });
        // Claude's token-versus-keychain question does not exist on codex, so it is not answered.
        expect(pin.auth).toBeUndefined();
        expect(pin.authSource).toBeUndefined();
    });

    /**
     * The bug this guards. A codex session started from inside a claude pane inherits
     * TOOLS_CLAUDE_ACCOUNT, and the env-first hook wrote that claude account against a codex
     * thread id — 9 times in the real journal before the harness check existed.
     */
    test("a codex session started inside a claude pane never captures the claude account", async () => {
        const code = await runHook(
            SafeJSON.stringify({
                session_id: "01a0862a-1cc3-7643-b2b9-2a06424f5276",
                transcript_path: CODEX_TRANSCRIPT,
            }),
            { TOOLS_CLAUDE_ACCOUNT: "personal", TOOLS_CLAUDE_AUTH: "token" }
        );

        expect(code).toBe(0);
        const [pin] = await readPins();
        expect(pin).toMatchObject({ provider: "codex", account: null });
    });

    test("a claude session is still untagged, so every existing record keeps its meaning", async () => {
        await runHook(
            SafeJSON.stringify({ session_id: "abc", transcript_path: "/Users/u/.claude/projects/p/abc.jsonl" }),
            {
                TOOLS_CLAUDE_ACCOUNT: "personal",
            }
        );

        const [pin] = await readPins();
        expect(pin.provider).toBeUndefined();
        expect(pin.account).toBe("personal");
    });
});

import { expect, test } from "bun:test";
import { withCrossMessages } from "@app/claude/lib/cross-messages";
import type { ClaudeLiveSession } from "@genesiscz/utils/claude/peer-message";
import { parseRegistryEntry, peerFrames } from "@genesiscz/utils/claude/peer-message";
import { SafeJSON } from "@genesiscz/utils/json";
import { claudeMessageDriver, codexMessageDriver, MessageError, pickClaudeSession } from "./message";

function live(sessionId: string, name: string | null, status = "idle"): ClaudeLiveSession {
    return {
        pid: 1,
        sessionId,
        name,
        cwd: "/repo/work",
        status,
        kind: "interactive",
        socketPath: "/s.sock",
        file: "/r.json",
    };
}

const SESSIONS = [
    live("aaaa1111-0000-4000-8000-000000000001", "review-shop"),
    live("aaaa2222-0000-4000-8000-000000000002", "review-side"),
    live("bbbb3333-0000-4000-8000-000000000003", "fix-login", "busy"),
];

test("a session is found by full id, id prefix, exact name or a unique part of its name", () => {
    expect(pickClaudeSession("bbbb3333-0000-4000-8000-000000000003", SESSIONS).name).toBe("fix-login");
    expect(pickClaudeSession("aaaa1111", SESSIONS).name).toBe("review-shop");
    expect(pickClaudeSession("REVIEW-SIDE", SESSIONS).sessionId).toBe("aaaa2222-0000-4000-8000-000000000002");
    expect(pickClaudeSession("login", SESSIONS).name).toBe("fix-login");
});

test("an ambiguous query fails with each candidate's exact command", () => {
    try {
        pickClaudeSession("review", SESSIONS);
        throw new Error("expected a MessageError");
    } catch (error) {
        expect(error).toBeInstanceOf(MessageError);
        expect((error as MessageError).suggestions).toEqual([
            'tools claude message aaaa1111-0000-4000-8000-000000000001 "<text>"',
            'tools claude message aaaa2222-0000-4000-8000-000000000002 "<text>"',
        ]);
    }
});

test("the Claude driver writes to the matched session's socket and says what the receiver does", async () => {
    const sent: { sessionId: string; text: string; token: string | null | undefined }[] = [];
    const driver = claudeMessageDriver({
        sessions: () => SESSIONS,
        token: () => "ab".repeat(16),
        send: async (input) => {
            sent.push({ sessionId: input.session.sessionId, text: input.text, token: input.token });
        },
        resolveId: async () => {
            throw new Error("not reached");
        },
    });

    const delivery = await driver.deliver({ query: "fix-login", text: "status?" });
    expect(sent).toEqual([
        { sessionId: "bbbb3333-0000-4000-8000-000000000003", text: "status?", token: "ab".repeat(16) },
    ]);
    expect(delivery).toMatchObject({ via: "claude-socket", note: "busy: it reads the message between tool calls" });
});

test("a /rename title resolves through the transcripts, and a session that is not running is refused", async () => {
    const driver = claudeMessageDriver({
        sessions: () => SESSIONS,
        token: () => null,
        send: async () => {},
        resolveId: async () => "cccc4444-0000-4000-8000-000000000004",
    });

    await expect(driver.deliver({ query: "old title", text: "x" })).rejects.toThrow("is not running");
});

test("codex queue failures name the shared app-server and the keystroke fallback", async () => {
    const driver = codexMessageDriver({
        resolveId: async () => "0199aaaa-0000-7000-8000-000000000001",
        queue: async () => ({ code: 1, stderr: "No active session" }),
    });

    await expect(driver.deliver({ query: "0199aaaa", text: "x" })).rejects.toThrow("--remote");
});

test("frames: auth line only with a token, then one user frame carrying the receiver's session id", () => {
    const [auth, user] = peerFrames({ sessionId: "s-1", text: "hi", token: "cd".repeat(16), priority: "next" })
        .trim()
        .split("\n")
        .map((line) => SafeJSON.parse(line, { strict: true }));

    expect(auth).toEqual({ type: "auth", token: "cd".repeat(16) });
    expect(user).toMatchObject({
        type: "user",
        message: { role: "user", content: "hi" },
        session_id: "s-1",
        priority: "next",
    });
    expect(peerFrames({ sessionId: "s-1", text: "hi" }).trim().split("\n")).toHaveLength(1);
});

test("a registry file without a messaging socket is not a target", () => {
    expect(parseRegistryEntry('{"pid":5,"sessionId":"s","messagingSocketPath":"/x.sock"}', "f")).toMatchObject({
        pid: 5,
    });
    expect(parseRegistryEntry('{"pid":5,"sessionId":"s"}', "f")).toBeNull();
    expect(parseRegistryEntry("not json", "f")).toBeNull();
});

test("--cross-messages puts the accept setting first and refuses a caller's own --settings", () => {
    expect(withCrossMessages(["--", "fix it"])).toEqual([
        "--settings",
        '{"crossSessionInbound":"accept"}',
        "--",
        "fix it",
    ]);
    expect(() => withCrossMessages(["--settings", "/x.json"])).toThrow("cannot be combined");
});

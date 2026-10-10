import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoSessionMatchError } from "@app/ai/lib/sessions/resolve-transcript";
import { startPassthrough, withCrossMessages } from "@app/claude/lib/cross-messages";
import type { ClaudeLiveSession } from "@genesiscz/utils/claude/peer-message";
import {
    listClaudeLiveSessions,
    liveClaudePids,
    parseRegistryEntry,
    peerFrames,
    sendClaudePeerMessage,
} from "@genesiscz/utils/claude/peer-message";
import { SafeJSON } from "@genesiscz/utils/json";
import { type BoundedCommandResult, boundedCommand } from "@genesiscz/utils/process/bounded-command";
import {
    claudeMessageDriver,
    codexMessageDriver,
    codexQueueResultOf,
    deliverMessage,
    grokMessageDriver,
    type MessageDelivery,
    MessageError,
    NoChannelError,
    pasteIntoSurface,
    pickClaudeSession,
    resolveSessionId,
    SessionQueryError,
} from "./delivery";

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
        queue: async () => ({ code: 1, stderr: "No active session", unknown: null }),
    });

    await expect(driver.deliver({ query: "0199aaaa", text: "x" })).rejects.toThrow("--remote");
});

test("only a codex queue that finished, or never started, has a known outcome", () => {
    const run = (overrides: Partial<BoundedCommandResult>): BoundedCommandResult => ({
        status: null,
        signal: null,
        stdout: "",
        stderr: "",
        ...overrides,
    });
    const failure = (code: string, message: string) => Object.assign(new Error(message), { code });

    // Finished: its status is the answer, so a refusal may fall back to keystrokes.
    expect(codexQueueResultOf(run({ status: 1, stderr: "No active session" })).unknown).toBeNull();
    expect(codexQueueResultOf(run({ status: 0 })).unknown).toBeNull();
    // Never started (no codex binary): nothing was queued either.
    expect(codexQueueResultOf(run({ error: failure("ENOENT", "spawn codex ENOENT") })).unknown).toBeNull();
    // Cut short after it may have queued: the deadline, the output budget, a signal.
    expect(codexQueueResultOf(run({ error: failure("ETIMEDOUT", "Command deadline reached.") })).unknown).toContain(
        "deadline"
    );
    expect(
        codexQueueResultOf(run({ status: 0, error: failure("ENOBUFS", "Command stdout exceeded its byte budget.") }))
            .unknown
    ).toContain("byte budget");
    expect(codexQueueResultOf(run({ signal: "SIGKILL" })).unknown).toContain("SIGKILL");
});

test("a real wrapped run killed by a signal or its deadline is an unknown codex queue outcome; a finished one is known", async () => {
    // The shared runner wraps the command in the child-deadline watchdog, which reports a kill as an exit status.
    const killed = await boundedCommand({ command: ["/bin/sh", "-c", "kill -9 $$"], timeoutMs: 10_000 });
    const deadline = await boundedCommand({ command: ["/bin/sleep", "5"], timeoutMs: 300 });
    const refused = await boundedCommand({
        command: ["/bin/sh", "-c", "echo 'No active session' >&2; exit 1"],
        timeoutMs: 10_000,
    });

    expect(killed.signal).toBeNull();
    expect(codexQueueResultOf(killed).unknown).toContain("signal 9");
    expect(codexQueueResultOf(deadline).unknown).not.toBeNull();
    // The control: a command that finished with its own status is a known refusal.
    expect(codexQueueResultOf(refused)).toEqual({ code: 1, stderr: "No active session", unknown: null });
});

test("a codex queue killed after it may have queued never falls back to keystrokes; a known refusal does", async () => {
    const killedRun = await boundedCommand({ command: ["/bin/sh", "-c", "kill -9 $$"], timeoutMs: 10_000 });
    const refusedRun = await boundedCommand({ command: ["/bin/sh", "-c", "exit 1"], timeoutMs: 10_000 });
    const sessionId = "0199aaaa-0000-7000-8000-000000000001";
    const deliver = (queued: BoundedCommandResult, paste: (input: { sessionId: string }) => Promise<MessageDelivery>) =>
        deliverMessage({
            alias: "codex",
            request: { query: "0199aaaa", text: "x" },
            allowKeystrokes: true,
            driver: codexMessageDriver({
                resolveId: async () => sessionId,
                queue: async () => codexQueueResultOf(queued),
            }),
            paste,
        });

    // The paste is the irreversible second send: it throws if it is reached.
    const forbidden = async (): Promise<MessageDelivery> => {
        throw new Error("the keystroke fallback must not run after a codex queue that may have queued");
    };
    const error = await deliver(killedRun, forbidden).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(MessageError);
    expect(error).not.toBeInstanceOf(NoChannelError);
    expect(error instanceof Error ? error.message : "").toContain("may or may not be queued");

    // The control: a finished refusal still falls back to the paste.
    const pasted: string[] = [];
    const delivered = await deliver(refusedRun, async (input) => {
        pasted.push(input.sessionId);
        return { agent: "codex", sessionId: input.sessionId, name: null, via: "cmux-paste", note: "pasted" };
    });
    expect(pasted).toEqual([sessionId]);
    expect(delivered.via).toBe("cmux-paste");
});

test("a codex queue past its deadline is an unknown send: no keystroke fallback, even when keystrokes are allowed", async () => {
    const driver = codexMessageDriver({
        resolveId: async () => "0199aaaa-0000-7000-8000-000000000001",
        queue: async () => ({ code: 1, stderr: "Command deadline reached.", unknown: "Command deadline reached." }),
    });
    const pasted: string[] = [];
    const paste = async (input: { sessionId: string }): Promise<MessageDelivery> => {
        pasted.push(input.sessionId);
        throw new Error("the keystroke fallback must not run after a timed-out queue");
    };

    const error = await deliverMessage({
        alias: "codex",
        request: { query: "0199aaaa", text: "x" },
        allowKeystrokes: true,
        driver,
        paste,
    }).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(MessageError);
    expect(error).not.toBeInstanceOf(NoChannelError);
    expect(error instanceof Error ? error.message : "").toContain("may or may not be queued");
    expect(pasted).toEqual([]);
});

test("no structured channel pastes only with --allow-keystrokes, and otherwise names the flag", async () => {
    const driver = grokMessageDriver({ resolveId: async () => "0199cccc-0000-7000-8000-000000000003" });
    const pasted: string[] = [];
    const paste = async (input: { sessionId: string; text: string }): Promise<MessageDelivery> => {
        pasted.push(`${input.sessionId} ${input.text}`);
        return { agent: "grok", sessionId: input.sessionId, name: null, via: "cmux-paste", note: "pasted" };
    };
    const request = { query: "vybava", text: "hello" };

    const refused = await deliverMessage({ alias: "grok", request, allowKeystrokes: false, driver, paste }).catch(
        (error: unknown) => error
    );
    expect(refused).toBeInstanceOf(MessageError);
    expect(refused instanceof MessageError ? refused.suggestions.join(" ") : "").toContain("--allow-keystrokes");
    expect(pasted).toEqual([]);

    const delivered = await deliverMessage({ alias: "grok", request, allowKeystrokes: true, driver, paste });
    expect(delivered.via).toBe("cmux-paste");
    expect(pasted).toEqual(["0199cccc-0000-7000-8000-000000000003 hello"]);
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
    // `tools claude run` gets the conflict as a usage error to print, not an uncaught exception.
    expect(startPassthrough(true, ["--settings", "/x.json"])).toEqual({
        error: expect.stringContaining("cannot be combined"),
    });
    expect(startPassthrough(false, ["--settings", "/x.json"])).toEqual({ args: ["--settings", "/x.json"] });
    expect(startPassthrough(true, ["--", "go"])).toEqual({
        args: ["--settings", '{"crossSessionInbound":"accept"}', "--", "go"],
    });
});

test("a message longer than one socket write arrives whole (Bun sockets do not buffer)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "peer-"));
    const socketPath = join(dir, "s.sock");
    const chunks: Buffer[] = [];
    const closed = Promise.withResolvers<void>();
    const server = Bun.listen({
        unix: socketPath,
        socket: {
            data(_socket, data) {
                chunks.push(Buffer.from(data));
            },
            close() {
                closed.resolve();
            },
        },
    });

    try {
        const text = "x".repeat(200_000);
        await sendClaudePeerMessage({ session: { sessionId: "s-1", socketPath, pid: 1 }, text });
        await closed.promise;
        const frame: unknown = SafeJSON.parse(Buffer.concat(chunks).toString("utf8").trim(), { strict: true });
        expect(frame).toMatchObject({ type: "user", session_id: "s-1", message: { content: text } });
    } finally {
        server.stop(true);
        rmSync(dir, { recursive: true, force: true });
    }
});

test("the keystroke fallback pastes through the bounded cmux runner and reports its timeout", async () => {
    const target = {
        sessionId: "cccc4444-0000-4000-8000-000000000004",
        agent: "grok" as const,
        surface: {
            ref: "surface:7",
            id: "uuid-surface:7",
            tty: "ttys007",
            workspace: "workspace:2",
            workspaceId: "uuid-workspace:2",
            window: "window:1",
            title: "side - grok",
            workspaceTitle: null,
        },
        cwd: "/repo/side",
    };
    const calls: string[][] = [];
    const delivered = await pasteIntoSurface({
        alias: "grok",
        sessionId: target.sessionId,
        text: "hello",
        live: async () => [target],
        run: async (args) => {
            calls.push(args);
            return { code: 0, stdout: "", stderr: "" };
        },
    });

    // The verified UUID, never the ref: a ref can name another terminal after a cmux restart.
    expect(calls).toEqual([["paste", "--surface", "uuid-surface:7", "--submit", "--", "hello"]]);
    expect(delivered).toMatchObject({ via: "cmux-paste", name: "side - grok" });

    const wedged = pasteIntoSurface({
        alias: "grok",
        sessionId: target.sessionId,
        text: "hello",
        live: async () => [target],
        run: async () => ({ code: -1, stdout: "", stderr: "cmux paste timed out after 30000 ms", timedOut: true }),
    });
    await expect(wedged).rejects.toThrow(MessageError);
    await expect(wedged).rejects.toThrow("timed out");

    const noUuid = pasteIntoSurface({
        alias: "grok",
        sessionId: target.sessionId,
        text: "hello",
        live: async () => [{ ...target, surface: { ...target.surface, id: null } }],
        run: async () => {
            throw new Error("cmux paste must not run without a surface UUID");
        },
    });
    await expect(noUuid).rejects.toThrow("no surface UUID");

    // A --via-tmux session: the surface shows tmux pane %41 only while the tmux client displays it.
    const tmuxTarget = {
        ...target,
        tmux: { pane: "%41", session: "work-grok", surface: "surface:7", paneTty: "ttys041", sessionCreatedMs: 0 },
    };
    const switched = pasteIntoSurface({
        alias: "grok",
        sessionId: target.sessionId,
        text: "hello",
        live: async () => [tmuxTarget],
        stillShown: async () => ({ ok: false, reason: "tmux shows another pane of work-grok now" }),
        run: async () => {
            throw new Error("cmux paste must not run after the user switched tmux panes");
        },
    });
    await expect(switched).rejects.toThrow("nothing was pasted");

    const shownCalls: string[][] = [];
    await pasteIntoSurface({
        alias: "grok",
        sessionId: target.sessionId,
        text: "hello",
        live: async () => [tmuxTarget],
        stillShown: async () => ({ ok: true }),
        run: async (args) => {
            shownCalls.push(args);
            return { code: 0, stdout: "", stderr: "" };
        },
    });
    expect(shownCalls).toHaveLength(1);
});

test("the live-session listing checks every registry pid in ONE batch, not one probe per entry", () => {
    const dir = mkdtempSync(join(tmpdir(), "gt-peer-registry-"));

    try {
        for (const pid of [101, 202, 303]) {
            writeFileSync(
                join(dir, `${pid}.json`),
                SafeJSON.stringify({
                    pid,
                    sessionId: `dddd${pid}-0000-4000-8000-000000000000`,
                    messagingSocketPath: `/s${pid}.sock`,
                })
            );
        }

        const batches: number[][] = [];
        const sessions = listClaudeLiveSessions(dir, (pids) => {
            batches.push([...pids].sort((a, b) => a - b));
            return new Set([202]);
        });

        expect(batches).toEqual([[101, 202, 303]]);
        expect(sessions.map((entry) => entry.pid)).toEqual([202]);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("a registry pid counts only while it runs and its command looks like Claude", () => {
    const exited = Bun.spawnSync(["true"], { env: process.env }).pid;

    expect(liveClaudePids([process.pid], () => true)).toEqual(new Set([process.pid]));
    // Negative control: the same live pid running something else is a recycled pid, not a session.
    expect(liveClaudePids([process.pid], () => false)).toEqual(new Set());
    expect(liveClaudePids([exited], () => true)).toEqual(new Set());
});

test("a title several sessions share keeps the resolver's answer when no cmux tab matches either", async () => {
    const ambiguous = async (): Promise<string> => {
        throw new Error('"shop" matches 2 grok sessions. Pass the session id, or --first for the newest');
    };
    const error = await resolveSessionId({
        alias: "grok",
        query: "shop",
        first: false,
        transcript: ambiguous,
        live: async () => [],
    }).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(SessionQueryError);
    expect(error instanceof Error ? error.message : "").toContain("--first");

    // The control: nothing matched at all still says so.
    const nothing = await resolveSessionId({
        alias: "grok",
        query: "nope",
        first: false,
        transcript: async () => {
            throw new NoSessionMatchError('No grok session matches "nope"');
        },
        live: async () => [],
    }).catch((failure: unknown) => failure);
    expect(nothing instanceof Error ? nothing.message : "").toContain('no grok session matches "nope"');
    expect(nothing).not.toBeInstanceOf(SessionQueryError);
});

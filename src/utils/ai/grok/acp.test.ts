import { describe, expect, test } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import {
    GrokAcpClient,
    GrokAcpError,
    GrokAcpRefusedError,
    type GrokAcpTransport,
    parseLeaderSessions,
    queuedPromptId,
} from "./acp";

interface Request {
    id: number;
    method: string;
    params: Record<string, unknown>;
}

type Reply = (message: Record<string, unknown>) => void;

/** An in-process `grok agent … stdio`: records every request and answers through `respond`. */
function fakeAgent(respond: (request: Request, reply: Reply) => void): {
    spawn: (argv: string[]) => GrokAcpTransport;
    argv: string[][];
    requests: Request[];
} {
    const argv: string[][] = [];
    const requests: Request[] = [];
    const encoder = new TextEncoder();

    return {
        argv,
        requests,
        spawn(args) {
            argv.push(args);
            let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
            const stdout = new ReadableStream<Uint8Array>({
                start(c) {
                    controller = c;
                },
            });
            const reply: Reply = (message) => {
                controller?.enqueue(encoder.encode(`${SafeJSON.stringify({ jsonrpc: "2.0", ...message })}\n`));
            };
            let exitCode: number | null = null;

            return {
                stdout,
                get exitCode() {
                    return exitCode;
                },
                kill() {
                    exitCode = 0;
                },
                stdin: {
                    write(chunk: string) {
                        for (const line of chunk.split("\n").filter(Boolean)) {
                            const request = SafeJSON.parse(line, { strict: true }) as Request;
                            requests.push(request);
                            queueMicrotask(() => respond(request, reply));
                        }
                    },
                    flush() {
                        return 0;
                    },
                },
            };
        },
    };
}

const SESSION_ID = "11111111-1111-4111-8111-111111111111";

function leaderAgent(prompt: (request: Request, reply: Reply) => void) {
    return fakeAgent((request, reply) => {
        if (request.method === "initialize") {
            reply({ id: request.id, result: { protocolVersion: 1 } });
        } else if (request.method === "authenticate") {
            reply({ id: request.id, result: {} });
        } else if (request.method === "session/list") {
            reply({
                id: request.id,
                result: {
                    sessions: [
                        {
                            sessionId: SESSION_ID,
                            cwd: "/private/tmp/fixture",
                            title: "Fixture",
                            updatedAt: "2026-10-30",
                        },
                        { cwd: "/no/id" },
                    ],
                },
            });
        } else if (request.method === "session/prompt") {
            prompt(request, reply);
        } else {
            reply({ id: request.id, error: { code: -32601, message: `unexpected ${request.method}` } });
        }
    });
}

describe("GrokAcpClient leader form", () => {
    test("joins the leader with the flags before stdio, initializes, authenticates and lists its sessions", async () => {
        const agent = leaderAgent(() => undefined);
        const client = new GrokAcpClient(0, {
            binPath: "/fixture/grok",
            leader: { socket: "/state/leader.sock" },
            env: { GROK_HOME: "/fixture-home" },
            spawn: agent.spawn,
        });

        const sessions = await client.listSessions();

        expect(agent.argv).toEqual([
            ["/fixture/grok", "agent", "--leader", "--leader-socket", "/state/leader.sock", "stdio"],
        ]);
        expect(agent.requests.map((request) => request.method)).toEqual(["initialize", "authenticate", "session/list"]);
        expect(agent.requests[1]?.params).toEqual({ methodId: "cached_token" });
        expect(sessions).toEqual([
            { sessionId: SESSION_ID, cwd: "/private/tmp/fixture", title: "Fixture", updatedAt: "2026-10-30" },
        ]);
        client.reset();
    });

    test("until queued resolves on the leader's queue notice, and never opens a session of its own", async () => {
        const agent = leaderAgent((_request, reply) => {
            reply({
                method: "_x.ai/queue/changed",
                params: { sessionId: "other", entries: [{ id: "p-other", text: "answer 4 b)" }] },
            });
            reply({
                method: "_x.ai/queue/changed",
                params: { sessionId: SESSION_ID, entries: [{ id: "p-1", kind: "prompt", text: "answer 4 b)" }] },
            });
            // No reply: the turn ends much later, and a queued wait does not wait for it.
        });
        const client = new GrokAcpClient(0, { leader: { socket: "/state/leader.sock" }, spawn: agent.spawn });

        const sent = await client.promptSession(SESSION_ID, "answer 4 b)", { until: "queued", timeoutMs: 2_000 });

        expect(sent).toEqual({ outcome: "queued", promptId: "p-1" });
        expect(agent.requests.map((request) => request.method)).toEqual([
            "initialize",
            "authenticate",
            "session/prompt",
        ]);
        expect(agent.requests[2]?.params).toEqual({
            sessionId: SESSION_ID,
            prompt: [{ type: "text", text: "answer 4 b)" }],
        });
        client.reset();
    });

    test("until completed waits for the turn's stop reason", async () => {
        const agent = leaderAgent((request, reply) => {
            reply({ id: request.id, result: { stopReason: "end_turn", _meta: { promptId: "p-2" } } });
        });
        const client = new GrokAcpClient(0, { leader: { socket: "/state/leader.sock" }, spawn: agent.spawn });

        expect(await client.promptSession(SESSION_ID, "hello")).toEqual({
            outcome: "completed",
            stopReason: "end_turn",
            promptId: "p-2",
        });
        client.reset();
    });

    test("an error reply is a refusal, and no acknowledgement in time is an unknown outcome", async () => {
        const refusing = leaderAgent((request, reply) => {
            reply({ id: request.id, error: { code: -32603, message: "Path not found (FS_NOT_FOUND)" } });
        });
        const refused = new GrokAcpClient(0, { leader: { socket: "/state/leader.sock" }, spawn: refusing.spawn });
        await expect(refused.promptSession(SESSION_ID, "hello", { until: "queued" })).rejects.toBeInstanceOf(
            GrokAcpRefusedError
        );
        refused.reset();

        const silent = leaderAgent(() => undefined);
        const waiting = new GrokAcpClient(0, { leader: { socket: "/state/leader.sock" }, spawn: silent.spawn });
        const error = await waiting
            .promptSession(SESSION_ID, "hello", { until: "queued", timeoutMs: 50 })
            .catch((e) => e);
        expect(error).toBeInstanceOf(GrokAcpError);
        expect(error).not.toBeInstanceOf(GrokAcpRefusedError);
        expect(String(error)).toContain("may have been accepted");
        waiting.reset();
    });

    test("the leader form refuses call(), and the plain form refuses the leader verbs", async () => {
        const leader = new GrokAcpClient(0, {
            leader: { socket: "/state/leader.sock" },
            spawn: fakeAgent(() => undefined).spawn,
        });
        await expect(leader.call("hi")).rejects.toThrow("a leader client uses promptSession()");

        const plain = new GrokAcpClient(0, { spawn: fakeAgent(() => undefined).spawn });
        await expect(plain.listSessions()).rejects.toThrow("needs the leader form");
        await expect(plain.promptSession(SESSION_ID, "hi")).rejects.toThrow("needs the leader form");
    });
});

describe("GrokAcpClient plain form", () => {
    test("runs grok agent stdio and answers one prompt on a fresh session, as before", async () => {
        const agent = fakeAgent((request, reply) => {
            if (request.method === "session/new") {
                reply({ id: request.id, result: { sessionId: "fresh" } });
                return;
            }

            if (request.method === "session/prompt") {
                reply({
                    method: "session/update",
                    params: {
                        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "PONG" } },
                    },
                });
                reply({ id: request.id, result: { stopReason: "end_turn" } });
                return;
            }

            reply({ id: request.id, result: {} });
        });
        const client = new GrokAcpClient(0, { binPath: "/fixture/grok", spawn: agent.spawn });

        expect(await client.call("PING")).toBe("PONG");
        expect(agent.argv).toEqual([["/fixture/grok", "agent", "stdio"]]);
        expect(agent.requests.map((request) => request.method)).toEqual([
            "initialize",
            "authenticate",
            "session/new",
            "session/prompt",
        ]);
        client.reset();
    });
});

test("the session list and queue notices are read field by field", () => {
    expect(parseLeaderSessions({ sessions: [{ sessionId: "a" }, "junk", { sessionId: 4 }] })).toEqual([
        { sessionId: "a" },
    ]);
    expect(parseLeaderSessions(null)).toEqual([]);
    expect(queuedPromptId({ sessionId: "a", runningText: "t", runningPromptId: "p" }, "a", "t")).toBe("p");
    expect(queuedPromptId({ sessionId: "a", entries: [{ id: "q", text: "t" }] }, "a", "t")).toBe("q");
    expect(queuedPromptId({ sessionId: "a", entries: [{ id: "q", text: "other" }] }, "a", "t")).toBe(false);
    expect(queuedPromptId({ sessionId: "b", runningText: "t" }, "a", "t")).toBe(false);
});

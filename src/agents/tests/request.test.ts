import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { watchFileFeed } from "@genesiscz/utils/fs/file-feed-watcher";
import { absentRecipients, withPositionalBody } from "../commands/message";
import { appendFeed, appendMessage, FeedLogCursor, readFeed } from "../lib/feed";
import { ensureSessionDir, sessionPaths } from "../lib/paths";
import { sendRequest } from "../lib/request";
import type { AgentRecord, FeedEvent } from "../lib/types";

describe("agents request", () => {
    test("feed cursors parse only appended records after the initial catch-up", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-agents-feed-cursor-"));

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            const paths = sessionPaths("cursor-test");
            ensureSessionDir(paths);
            const first = await appendFeed(paths, {
                type: "registered",
                agent_name: "lead",
                agent_id: "main_test",
                awaiting_login: false,
                is_main: true,
                role: null,
                meta: {},
            });
            const samples: Array<{ bytes: number; records: number }> = [];
            const cursor = new FeedLogCursor({ paths, sinceSeq: 0, onRead: (sample) => samples.push(sample) });

            expect(await cursor.readAppended()).toEqual([first]);
            const afterCatchUp = [...samples];
            expect(await cursor.readAppended()).toEqual([]);
            expect(samples).toEqual(afterCatchUp);

            const second = await appendFeed(paths, {
                type: "logged_in",
                agent_id: "main_test",
                agent_name: "lead",
                mode: "stream",
            });
            expect(await cursor.readAppended()).toEqual([second]);
            expect(samples.at(-1)?.records).toBe(1);
        });
    });

    test("blocks until a correlated reply arrives", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-agents-request-"));

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            const paths = sessionPaths("request-test");
            ensureSessionDir(paths);
            await appendFeed(paths, {
                type: "registered",
                agent_name: "lead",
                agent_id: "main_test",
                awaiting_login: false,
                is_main: true,
                role: null,
                meta: {},
            });
            await appendFeed(paths, {
                type: "registered",
                agent_name: "worker",
                agent_id: "agt_0001",
                awaiting_login: false,
                is_main: false,
                role: null,
                meta: {},
            });

            const pending = sendRequest({
                session: "request-test",
                from: "lead",
                to: "worker",
                body: "approve?",
                // A deadline, not a delay: the reply below resolves it at once. 1 s ran out under the
                // parallel suite's load (failed at 1019 ms, 2026-10-04).
                timeoutMs: 10_000,
            });
            // The request lands in the feed asynchronously: wake on the feed's change event, not a short poll.
            let request = (await readFeed(paths)).find((event) => event.type === "message");

            if (!request) {
                await watchFileFeed({
                    path: paths.feedPath,
                    deadlineAt: Date.now() + 5_000,
                    onChange: async () => {
                        request = (await readFeed(paths)).find((event) => event.type === "message");

                        return request ? { done: true } : undefined;
                    },
                });
            }

            expect(request?.type).toBe("message");

            if (request?.type !== "message") {
                throw new Error("request message missing");
            }

            await appendMessage(paths, {
                type: "message",
                from_agent_id: "agt_0001",
                from_agent_name: "worker",
                to_agent_ids: ["main_test"],
                body: '{"op":"approve"}',
                meta: {},
                private: false,
                in_reply_to: request.message_id,
            });

            await expect(pending).resolves.toMatchObject({
                from_agent_name: "worker",
                in_reply_to: request.message_id,
                body: '{"op":"approve"}',
            });
        });
    });

    test("times out without a reply", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-agents-request-timeout-"));

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
            const paths = sessionPaths("request-timeout");
            ensureSessionDir(paths);
            await appendFeed(paths, {
                type: "registered",
                agent_name: "lead",
                agent_id: "main_test",
                awaiting_login: false,
                is_main: true,
                role: null,
                meta: {},
            });
            await appendFeed(paths, {
                type: "registered",
                agent_name: "worker",
                agent_id: "agt_0001",
                awaiting_login: false,
                is_main: false,
                role: null,
                meta: {},
            });

            await expect(
                sendRequest({
                    session: "request-timeout",
                    from: "lead",
                    to: "worker",
                    body: "approve?",
                    timeoutMs: 20,
                })
            ).rejects.toThrow("timed out");
        });
    });
});

describe("agents message body", () => {
    test("positional words are the body, and a second source is refused", () => {
        expect(withPositionalBody(["hello", "there"], { to: "worker" }).body).toBe("hello there");
        expect(withPositionalBody([], { body: "kept" }).body).toBe("kept");
        expect(() => withPositionalBody(["twice"], { body: "already" })).toThrow("given twice");
        expect(() => withPositionalBody(["twice"], { bodyFile: "/tmp/x" })).toThrow("given twice");
    });

    test("the receipt never lists the sender, whose own login would never deliver its own message", () => {
        const left = (seq: number, agentId: string, name: string, loginId: string): FeedEvent[] =>
            [
                {
                    seq,
                    ts: "2026-01-01T00:00:01Z",
                    type: "logged_in",
                    agent_id: agentId,
                    agent_name: name,
                    mode: "stream",
                    login_id: loginId,
                },
                {
                    seq: seq + 1,
                    ts: "2026-01-01T00:00:02Z",
                    type: "agent_left",
                    agent_id: agentId,
                    agent_name: name,
                    reason: "leave",
                    remaining: [],
                    login_id: loginId,
                },
            ] as FeedEvent[];
        const events = [...left(1, "agt_alpha", "alpha", "alpha-1"), ...left(3, "agt_beta", "beta", "beta-1")];
        const registry = [
            { agent_id: "agt_alpha", agent_name: "alpha" },
            { agent_id: "agt_beta", agent_name: "beta" },
        ] as AgentRecord[];

        const absent = absentRecipients({ events, registry, toIds: ["agt_alpha", "agt_beta"], senderId: "agt_alpha" });

        expect(absent).toMatchObject([{ agent_id: "agt_beta", name: "beta", state: "left", reason: "leave" }]);
    });
});

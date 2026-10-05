import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { watchFileFeed } from "@genesiscz/utils/fs/file-feed-watcher";
import { appendFeed, appendMessage, readFeed } from "../lib/feed";
import { ensureSessionDir, sessionPaths } from "../lib/paths";
import { sendRequest } from "../lib/request";

describe("agents request", () => {
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

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AskDeps } from "@app/question/lib/pending/ask";
import { PENDING_MIGRATIONS } from "@app/question/lib/pending/store";
import { type Migration, runMigrations } from "@genesiscz/utils/database/migrations";
import { SafeJSON } from "@genesiscz/utils/json";
import {
    handleQuestionCancel,
    handleQuestionPoll,
    handleQuestionPost,
    handleQuestionRespond,
    handleQuestionWait,
    type QuestionDeps,
} from "./question-post";
import { handleQuestionUpdate } from "./question-update";

let deps: AskDeps;
let db: Database;

beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db, PENDING_MIGRATIONS as Migration[], { tableName: "qa_pending" });
    const scratch = mkdtempSync(join(tmpdir(), "gt-mcp-ask-"));
    deps = { db, eventBase: join(scratch, "events"), logBase: join(scratch, "log"), notify: false };
});

afterEach(() => {
    db.close();
});

function idIn(text: string): string {
    const match = text.match(/ask_[0-9a-f-]+/);

    if (!match) {
        throw new Error(`no form id in: ${text}`);
    }

    return match[0];
}

describe("question_post", () => {
    test("creates a pending form and does NOT block by default", async () => {
        const text = await handleQuestionPost(
            { projectPath: "/tmp/gt-mcp-fixture", question: "Ship?", choices: ["yes", "no"] },
            deps
        );

        expect(text).toContain("Posted");
        expect(text).toContain("[pending]");
        expect(handleQuestionPoll({}, deps)).toContain(idIn(text));
    });

    test("a multi-item form keeps every item", async () => {
        const text = await handleQuestionPost(
            {
                projectPath: "/tmp/gt-mcp-fixture",
                items: [{ promptMarkdown: "Target?", choices: ["staging", "prod"] }, { promptMarkdown: "Notes?" }],
            },
            deps
        );

        expect(text).toContain("+1 more");
    });

    test("neither a question nor items is a clear refusal", async () => {
        await expect(handleQuestionPost({ projectPath: "/tmp/gt-mcp-fixture" }, deps)).rejects.toThrow(
            "either `question` or a non-empty `items`"
        );
    });

    test("wait: true returns the waiter verdict rather than a bare id", async () => {
        const text = await handleQuestionPost(
            { projectPath: "/tmp/gt-mcp-fixture", question: "Ship?", wait: true, waitTimeoutMs: 20 },
            deps
        );

        expect(text).toContain("waiter: budget_exhausted");
    });
});

describe("question_respond", () => {
    test("answering reports the history entry it wrote", async () => {
        const posted = await handleQuestionPost({ projectPath: "/tmp/gt-mcp-fixture", question: "Ship?" }, deps);
        const text = await handleQuestionRespond(
            { id: idIn(posted), answers: [{ itemId: "q1", freeText: "go" }] },
            deps
        );

        expect(text).toContain("logged to the Q→A history");
    });

    test("an incomplete answer names the missing items instead of throwing", async () => {
        const posted = await handleQuestionPost(
            { projectPath: "/tmp/gt-mcp-fixture", items: [{ promptMarkdown: "A?" }, { promptMarkdown: "B?" }] },
            deps
        );
        const text = await handleQuestionRespond(
            { id: idIn(posted), answers: [{ itemId: "q1", freeText: "a" }] },
            deps
        );

        expect(text).toContain("incomplete");
        expect(text).toContain("missing: q2");
    });
});

describe("question_wait and question_cancel", () => {
    test("cancel releases a waiter as cancelled", async () => {
        const posted = await handleQuestionPost({ projectPath: "/tmp/gt-mcp-fixture", question: "Ship?" }, deps);
        const id = idIn(posted);
        const waiting = handleQuestionWait({ id, timeoutMs: 5_000 }, deps);
        handleQuestionCancel({ id }, deps);

        expect(await waiting).toContain("waiter: cancelled");
    });

    test("cancelling twice says the form is already resolved", async () => {
        const posted = await handleQuestionPost({ projectPath: "/tmp/gt-mcp-fixture", question: "Ship?" }, deps);
        const id = idIn(posted);
        handleQuestionCancel({ id }, deps);

        expect(handleQuestionCancel({ id }, deps)).toContain("already cancelled");
    });

    test("an unknown id is reported, never thrown", async () => {
        expect(await handleQuestionWait({ id: "ask_nope" }, deps)).toContain("unknown form");
        expect(handleQuestionCancel({ id: "ask_nope" }, deps)).toContain("unknown form");
    });
});

describe("question_poll", () => {
    test("a poll with explicit ids carries the ANSWER, not just the status line", async () => {
        // The tool description tells an agent to collect the answer with question_poll, and
        // the summary line alone made that impossible.
        const posted = await handleQuestionPost({ question: "Ship?", projectPath: "/tmp/gt-mcp" }, deps);
        const id = idIn(posted);
        await handleQuestionRespond({ id, answers: [{ itemId: "q1", freeText: "ship it" }] }, deps);
        const polled = handleQuestionPoll({ ids: [id] }, deps);

        expect(polled).toContain("ship it");
        expect(polled).toContain("entryId");
        expect(polled).toContain("answered");
    });
    test("no ids lists pending forms; unknown ids are marked", async () => {
        await handleQuestionPost({ projectPath: "/tmp/gt-mcp-fixture", question: "Ship?" }, deps);

        expect(handleQuestionPoll({}, deps)).toContain("[pending]");
        expect(handleQuestionPoll({ ids: ["ask_nope"] }, deps)).toContain("ask_nope [unknown]");
    });

    test("a non-array ids is rejected, not iterated character by character", () => {
        // The MCP dispatch layer casts raw JSON-RPC arguments without validating against the
        // registered inputSchema, so a string here is exactly what a malformed tool call sends.
        // A bare string is iterable, so treating it as an array polled one form per CHARACTER.
        const args = { ids: "ask_123" } as unknown as { ids?: string[] };

        expect(() => handleQuestionPoll(args, deps)).toThrow(/ids/i);
    });

    test.each([
        ["an object", [{}]],
        ["null", [null]],
        ["a number", [42]],
    ])("a %s member is rejected, not passed straight into the store lookup", (_label, ids) => {
        // The container check alone lets `{"ids":[{}]}` through: it is an array, so `Array.isArray`
        // passes, but the non-string member still reaches `getForms`'s `for (const id of ids)`.
        const args = { ids } as unknown as { ids?: string[] };

        expect(() => handleQuestionPoll(args, deps)).toThrow(/ids/i);
    });
});

describe("question_post decisions and question_update", () => {
    function withLog(): QuestionDeps & { decisionLog: { file: string; events: string; session: string } } {
        const dir = mkdtempSync(join(tmpdir(), "gt-mcp-decisions-"));

        return {
            ...deps,
            decisionLog: { file: join(dir, "decisions.jsonl"), events: join(dir, "events.jsonl"), session: "sess-1" },
        };
    }

    test("decision and todo items are numbered in the decision log and never become a form", async () => {
        const logDeps = withLog();
        const text = await handleQuestionPost(
            {
                sessionHint: "sess-1",
                items: [
                    {
                        type: "decision",
                        title: "Cache",
                        promptMarkdown: "Keep it?",
                        choices: ["yes", "no"],
                        recommended: "a",
                    },
                    { type: "todo", promptMarkdown: "Rerun the bench", for: "agent" },
                ],
            },
            logDeps
        );

        expect(text).toContain("Posted d_1_sess-1, t_1_sess-1");
        expect(text).toContain("### ❓ DECISION 1 — Cache");
        expect(text).toContain("a) yes (recommended)");
        expect(text).toContain("### ☐ TODO 1");
        expect(text).not.toMatch(/ask_[0-9a-f-]+/);
        expect(handleQuestionPoll({}, { ...deps, decisionLog: { ...logDeps.decisionLog, session: null } })).toBe(
            "No pending ask forms."
        );
    });

    test("a mixed batch posts the questions as one form and the decisions to the log", async () => {
        const logDeps = withLog();
        const text = await handleQuestionPost(
            {
                sessionHint: "sess-1",
                projectPath: "/tmp/gt-mcp-fixture",
                items: [
                    { promptMarkdown: "Which env?" },
                    { type: "decision", promptMarkdown: "Ship?", choices: ["y"] },
                ],
            },
            logDeps
        );

        expect(idIn(text)).toMatch(/^ask_/);
        expect(text).toContain("❓ DECISION 1");
    });

    test("a mixed batch writes neither half when either one is invalid", async () => {
        const logDeps = withLog();
        const base = { sessionHint: "sess-1", projectPath: "/tmp/gt-mcp-fixture" };
        const decision = { type: "decision" as const, promptMarkdown: "Ship?", choices: ["y"] };

        // A bad form: the decisions used to be stored first, and a retry stored them again.
        await expect(
            handleQuestionPost(
                {
                    ...base,
                    items: [{ id: "q", promptMarkdown: "A?" }, { id: "q", promptMarkdown: "B?" }, decision],
                },
                logDeps
            )
        ).rejects.toThrow(/duplicate item id/);
        expect(existsSync(logDeps.decisionLog.file)).toBe(false);

        // A bad decision: the form is not posted either.
        await expect(
            handleQuestionPost(
                { ...base, items: [{ promptMarkdown: "Which env?" }, { ...decision, promptMarkdown: "" }] },
                logDeps
            )
        ).rejects.toThrow(/invalid decision post/);
        expect(handleQuestionPoll({}, { ...deps, decisionLog: { ...logDeps.decisionLog, session: null } })).toBe(
            "No pending ask forms."
        );
    });

    test("question_update moves a batch as one change; poll then shows the unacknowledged answer", async () => {
        const logDeps = withLog();
        await handleQuestionPost(
            {
                sessionHint: "sess-1",
                items: [
                    { type: "decision", promptMarkdown: "Keep it?", choices: ["yes", "no"] },
                    { type: "decision", promptMarkdown: "Rename?", choices: ["yes"] },
                ],
            },
            logDeps
        );
        await expect(
            handleQuestionUpdate(
                {
                    updates: [
                        { id: "d_1_sess-1", state: "answered", option: "b" },
                        { id: "d_9_sess-1", state: "answered", answer: "x" },
                    ],
                },
                logDeps
            )
        ).rejects.toThrow(/no decision d_9_sess-1/);
        expect(handleQuestionPoll({ ids: ["d_1_sess-1"] }, logDeps)).toContain("d_1_sess-1 [open]");

        const updated = SafeJSON.parse(
            await handleQuestionUpdate({ updates: [{ id: "d_1_sess-1", state: "answered", option: "b" }] }, logDeps)
        ) as { updated: Array<{ state: string }> };
        expect(updated.updated.map((row) => row.state)).toEqual(["answered"]);

        const polled = handleQuestionPoll({}, logDeps);
        expect(polled).toContain("Answered decisions not yet acknowledged");
        expect(polled).toContain('"option": "b"');
        expect(handleQuestionPoll({ ids: ["d_2_sess-1", "d_7_sess-1"] }, logDeps)).toContain("d_7_sess-1 [unknown]");
    });
});

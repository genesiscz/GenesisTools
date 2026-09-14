import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AskDeps } from "@app/question/lib/pending/ask";
import { PENDING_MIGRATIONS } from "@app/question/lib/pending/store";
import { type Migration, runMigrations } from "@genesiscz/utils/database/migrations";
import {
    handleQuestionCancel,
    handleQuestionPoll,
    handleQuestionPost,
    handleQuestionRespond,
    handleQuestionWait,
} from "./question-post";

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
    test("no ids lists pending forms; unknown ids are marked", async () => {
        await handleQuestionPost({ projectPath: "/tmp/gt-mcp-fixture", question: "Ship?" }, deps);

        expect(handleQuestionPoll({}, deps)).toContain("[pending]");
        expect(handleQuestionPoll({ ids: ["ask_nope"] }, deps)).toContain("ask_nope [unknown]");
    });
});

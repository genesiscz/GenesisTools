import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { getIndexedClaudeConversation, searchIndexedClaudeHistory } from "./indexed-search";
import type { AssistantMessage } from "./types";

test("indexed Claude history preserves original matching records and legacy result fields", async () => {
    const root = mkdtempSync(join(tmpdir(), "gt-claude-indexed-"));
    const project = join(root, "-projects-shop");
    mkdirSync(project);
    const file = join(project, "11111111-2222-4333-8444-555555555555.jsonl");
    const message: AssistantMessage = {
        type: "assistant",
        uuid: "message-1",
        parentUuid: null,
        userType: "external",
        sessionId: "11111111-2222-4333-8444-555555555555",
        timestamp: "2026-09-01T10:00:00Z",
        cwd: "/projects/shop",
        gitBranch: "feature-invoices",
        message: {
            role: "assistant",
            id: "message-1",
            model: "fixture-model",
            type: "message",
            stop_reason: "tool_use",
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
            content: [
                {
                    type: "tool_use",
                    id: "call-1",
                    name: "Edit",
                    input: { file_path: "src/invoice.ts", new_string: "refund rounding" },
                },
            ],
        },
    };
    writeFileSync(
        file,
        [{ type: "custom-title", customTitle: "Invoice repairs" }, message]
            .map((row) => SafeJSON.stringify(row))
            .join("\n")
    );
    const db = new Database(":memory:");
    try {
        const results = await searchIndexedClaudeHistory({
            filters: { project: "-projects-shop", query: "refund", file: "*.ts", tool: "Edit" },
            roots: [root],
            database: db,
        });
        expect(results).toHaveLength(1);
        expect(results[0]?.customTitle).toBe("Invoice repairs");
        expect(results[0]?.gitBranch).toBe("feature-invoices");
        expect(results[0]?.matchedMessages).toEqual([message]);
        expect(results[0]?.isSubagent).toBe(false);
        const warm = await searchIndexedClaudeHistory({ filters: { query: "refund" }, roots: [root], database: db });
        expect(warm[0]?.matchedMessages).toEqual([message]);
    } finally {
        db.close();
    }
});

test.each([
    { query: "refund penny" },
    { query: "refund penny", exact: true },
    { query: "refund", tool: "Edit", file: "*.ts" },
    { query: "Edit src/invoice.ts tax correction", exact: true },
])("query and tool/file filters combine blocks from one original Claude message: %j", async (filters) => {
    const root = mkdtempSync(join(tmpdir(), "gt-claude-message-group-"));
    const file = join(root, "11111111-2222-4333-8444-555555555555.jsonl");
    writeFileSync(
        file,
        SafeJSON.stringify({
            type: "assistant",
            sessionId: "11111111-2222-4333-8444-555555555555",
            cwd: "/projects/shop",
            message: {
                content: [
                    { type: "text", text: "refund" },
                    { type: "text", text: "penny" },
                    {
                        type: "tool_use",
                        id: "call-1",
                        name: "Edit",
                        input: { file_path: "src/invoice.ts", new_string: "tax correction" },
                    },
                ],
            },
        }) + "\n"
    );
    const db = new Database(":memory:");
    try {
        const results = await searchIndexedClaudeHistory({ filters, roots: [root], database: db });
        expect(results).toHaveLength(1);
        expect(results[0]?.matchedMessages).toHaveLength(1);
        expect(results[0]?.matchedMessages[0]?.type).toBe("assistant");
    } finally {
        db.close();
    }
});

test("Claude original-record mapping preserves valid JSON Unicode separators", async () => {
    const root = mkdtempSync(join(tmpdir(), "gt-claude-json-separators-"));
    const text = "refund\u2028line\u2029paragraph";
    writeFileSync(
        join(root, "11111111-2222-4333-8444-555555555555.jsonl"),
        `${SafeJSON.stringify({ type: "user", sessionId: "11111111-2222-4333-8444-555555555555", cwd: "/projects/shop", message: { role: "user", content: text } })}\n`
    );
    const db = new Database(":memory:");
    try {
        const results = await searchIndexedClaudeHistory({ filters: { query: "refund" }, roots: [root], database: db });
        const message = results[0]?.matchedMessages[0];
        expect(message?.type).toBe("user");
        if (message?.type !== "user") {
            throw new Error("Expected original user message");
        }
        expect(message.message.content).toBe(text);
    } finally {
        db.close();
    }
});

test("indexed detail resolves a native id and returns every original record", async () => {
    const root = mkdtempSync(join(tmpdir(), "gt-claude-detail-"));
    const sessionId = "11111111-2222-4333-8444-555555555555";
    const records = [
        { type: "progress", data: { message: "preparing" } },
        {
            type: "user",
            sessionId,
            cwd: "/projects/shop",
            timestamp: "2026-09-01T10:00:00Z",
            message: { role: "user", content: "open invoice" },
        },
        { type: "summary", summary: "Invoice session" },
    ];
    writeFileSync(join(root, `${sessionId}.jsonl`), `${records.map((row) => SafeJSON.stringify(row)).join("\n")}\n`);
    const db = new Database(":memory:");

    try {
        const result = await getIndexedClaudeConversation({ sessionId, roots: [root], database: db });
        expect(result?.sessionId).toBe(sessionId);
        expect(result?.summary).toBe("Invoice session");
        expect(result?.matchedMessages.map((record) => SafeJSON.stringify(record))).toEqual(
            records.map((record) => SafeJSON.stringify(record))
        );
    } finally {
        db.close();
    }
});

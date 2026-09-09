import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import type { NativeSessionSource } from "../types";
import {
    createGrokHistoryOperations,
    extractGrokUserQueriesFromRecord,
    readGrokMetadata,
    readGrokRecords,
    scanGrokRecords,
} from "./grok";

const SESSION_ID = "11111111-2222-4333-8444-555555555555";
const CWD = "/projects/shop";

function line(record: object): string {
    return `${SafeJSON.stringify(record, { strict: true })}\n`;
}

test("summaryless chat metadata derives native identity and cwd from its session layout", async () => {
    const home = mkdtempSync(join(tmpdir(), "gt-grok-summaryless-"));
    const root = join(home, "sessions");
    const directory = join(root, encodeURIComponent(CWD), SESSION_ID);
    mkdirSync(directory, { recursive: true });
    const chatPath = join(directory, "chat_history.jsonl");
    writeFileSync(
        chatPath,
        line({
            type: "user",
            timestamp: "2026-09-01T10:00:00.000Z",
            content: [{ type: "text", text: "<user_info>system wrapper</user_info>" }],
        }) +
            line({
                type: "user",
                timestamp: "2026-09-01T10:01:00.000Z",
                content: [{ type: "text", text: "<user_query>\nrepair invoices 🙂\n</user_query>" }],
            })
    );
    const source: NativeSessionSource<"grok"> = {
        kind: "grok",
        root,
        sourceHome: home,
        filePath: chatPath,
        dataPaths: [chatPath],
        metadataPaths: [],
    };

    const result = await readGrokMetadata(source);

    expect(result.complete).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.metadata).toMatchObject({
        nativeId: SESSION_ID,
        sessionId: SESSION_ID,
        cwd: CWD,
        project: "shop",
        customTitle: "repair invoices 🙂",
        summary: null,
        firstPrompt: "repair invoices 🙂",
        allUserText: "repair invoices 🙂",
        firstTimestamp: "2026-09-01T10:00:00.000Z",
        lastTimestamp: "2026-09-01T10:01:00.000Z",
        sourceHome: home,
        root,
        archived: false,
        resumeMode: "native",
        boundedFields: [],
    });
});

test("scan prefers canonical chat, excludes usage updates, and links tool results", async () => {
    const home = mkdtempSync(join(tmpdir(), "gt-grok-scan-"));
    const root = join(home, "sessions");
    const directory = join(root, encodeURIComponent(CWD), SESSION_ID);
    mkdirSync(directory, { recursive: true });
    const canonical = join(directory, "chat_history.jsonl");
    const alternate = join(directory, "chatHistory.jsonl");
    const updates = join(directory, "updates.jsonl");
    const rows = [
        {
            type: "user",
            timestamp: "2026-09-01T10:00:00.000Z",
            content: [{ type: "text", text: "<user_info>wrapper only</user_info>" }],
        },
        {
            type: "user",
            timestamp: "2026-09-01T10:01:00.000Z",
            content: [{ type: "text", text: "<user_query>Inspect invoice</user_query>" }],
        },
        {
            type: "assistant",
            timestamp: "2026-09-01T10:02:00.000Z",
            content: [
                { type: "text", text: "Checking it" },
                { type: "thinking", thinking: "Need exact cents" },
                {
                    type: "tool_use",
                    id: "tool-1",
                    name: "Edit",
                    input: { file_path: "src/invoice.ts", new_string: "integer cents" },
                },
            ],
        },
        {
            type: "user",
            timestamp: "2026-09-01T10:03:00.000Z",
            content: [{ type: "tool_result", tool_use_id: "tool-1", content: "edited result mentions docs/result.md" }],
        },
        { type: "usage", input_tokens: 10, output_tokens: 4 },
    ];
    writeFileSync(canonical, rows.map((row) => SafeJSON.stringify(row, { strict: true })).join("\n"));
    writeFileSync(
        alternate,
        line({ type: "assistant", content: [{ type: "text", text: "ALTERNATE_MUST_NOT_DUPLICATE" }] })
    );
    writeFileSync(updates, line({ type: "user", content: "USAGE_UPDATE_MUST_NOT_BE_CHAT" }));
    const source: NativeSessionSource<"grok"> = {
        kind: "grok",
        root,
        sourceHome: home,
        filePath: canonical,
        dataPaths: [updates, alternate, canonical],
        metadataPaths: [],
    };
    const records = [];
    for await (const record of scanGrokRecords(source)) {
        records.push(record);
    }

    expect(records.map((record) => [record.position, record.locator, record.entries.length])).toEqual([
        [0, "jsonl:1", 0],
        [1, "jsonl:2", 1],
        [2, "jsonl:3", 3],
        [3, "jsonl:4", 1],
        [4, "jsonl:5", 0],
    ]);
    expect(records.map((record) => record.role)).toEqual(["user", "user", "assistant", "user", undefined]);
    expect(records[0]?.timestamp).toBe("2026-09-01T10:00:00.000Z");
    expect(records[1]?.entries[0]).toMatchObject({
        role: "user",
        text: "Inspect invoice",
        line: 2,
    });
    expect(records[2]?.entries.map((entry) => entry.role)).toEqual(["assistant", "thinking", "tool"]);
    expect(records[2]?.entries[2]).toMatchObject({
        tool: "Edit",
        toolEvent: "call",
        inputText: "src/invoice.ts integer cents",
        paths: ["src/invoice.ts"],
        line: 3,
    });
    expect(records[3]?.entries[0]).toMatchObject({
        tool: "Edit",
        toolEvent: "result",
        text: "edited result mentions docs/result.md",
        paths: ["src/invoice.ts"],
        line: 4,
    });
    expect("inputText" in records[3]!.entries[0]!).toBe(false);
    expect(records[4]?.original).toBe(SafeJSON.stringify(rows[4], { strict: true }));
    const searchable = records
        .flatMap((record) => record.entries)
        .map((entry) => entry.text)
        .join("\n");
    expect(searchable).not.toContain("ALTERNATE_MUST_NOT_DUPLICATE");
    expect(searchable).not.toContain("USAGE_UPDATE_MUST_NOT_BE_CHAT");
});

test("selected reads preserve exact EOF originals and report incomplete coverage", async () => {
    const home = mkdtempSync(join(tmpdir(), "gt-grok-selected-"));
    const root = join(home, "sessions");
    const directory = join(root, encodeURIComponent(CWD), SESSION_ID);
    mkdirSync(directory, { recursive: true });
    const chatPath = join(directory, "chatHistory.jsonl");
    const selected = SafeJSON.stringify(
        {
            type: "assistant",
            timestamp: "2026-09-01T10:05:00.000Z",
            content: [{ type: "text", text: "Selected Unicode context 🙂" }],
        },
        { strict: true }
    );
    writeFileSync(
        chatPath,
        [line({ type: "user", content: "not selected" }).trimEnd(), '{"broken":', selected].join("\n")
    );
    const source: NativeSessionSource<"grok"> = {
        kind: "grok",
        root,
        sourceHome: home,
        filePath: chatPath,
        dataPaths: [chatPath],
        metadataPaths: [],
    };

    const result = await readGrokRecords(source, { locators: ["jsonl:3", "jsonl:99"] });

    expect(result.records.map((record) => [record.position, record.locator, record.original])).toEqual([
        [1, "jsonl:3", selected],
    ]);
    expect(result.complete).toBe(false);
    expect(result.issues.map((entry) => entry.message)).toEqual([
        "Malformed record at line 2",
        "Record locator not found: jsonl",
    ]);
    expect(result.issues.map((entry) => entry.message).join("\n")).not.toContain('{"broken"');
});

test("metadata bounds Unicode fields without retaining huge tool output", async () => {
    const home = mkdtempSync(join(tmpdir(), "gt-grok-bounds-"));
    const root = join(home, "sessions");
    const directory = join(root, encodeURIComponent(CWD), SESSION_ID);
    mkdirSync(directory, { recursive: true });
    const chatPath = join(directory, "chat_history.jsonl");
    const summaryPath = join(directory, "summary.json");
    const hugePrompt = `prompt-${"🙂".repeat(5_000)}`;
    const hugeOutput = `GROK_TOOL_OUTPUT_SOURCE_ONLY_${"x".repeat(1024 * 1024)}`;
    writeFileSync(
        chatPath,
        line({ type: "user", content: [{ type: "text", text: `<user_query>${hugePrompt}</user_query>` }] }) +
            line({
                type: "user",
                content: [{ type: "tool_result", tool_use_id: "tool-1", content: hugeOutput }],
            })
    );
    writeFileSync(
        summaryPath,
        SafeJSON.stringify(
            {
                info: { id: SESSION_ID, cwd: CWD },
                generated_title: "T".repeat(5_000),
                session_summary: "🙂".repeat(5_000),
                created_at: "2026-09-01T10:00:00.000Z",
                updated_at: "2026-09-01T10:05:00.000Z",
            },
            { strict: true }
        )
    );
    const source: NativeSessionSource<"grok"> = {
        kind: "grok",
        root,
        sourceHome: home,
        filePath: summaryPath,
        dataPaths: [chatPath],
        metadataPaths: [summaryPath],
    };

    const result = await readGrokMetadata(source);

    expect(result.complete).toBe(true);
    expect(result.metadata?.boundedFields).toEqual(["customTitle", "summary", "firstPrompt", "allUserText"]);
    expect(result.metadata?.storageTruncatedFields).toEqual(["customTitle", "summary", "firstPrompt"]);
    expect(Buffer.byteLength(result.metadata?.customTitle ?? "", "utf8")).toBe(4_096);
    expect(Buffer.byteLength(result.metadata?.summary ?? "", "utf8")).toBe(16_384);
    expect(Buffer.byteLength(result.metadata?.firstPrompt ?? "", "utf8")).toBeLessThanOrEqual(16_384);
    expect(result.metadata?.firstPrompt).not.toContain("�");
    expect(result.metadata?.allUserText?.length).toBe(5_000);
    expect(SafeJSON.stringify(result.metadata, { strict: true })).not.toContain("GROK_TOOL_OUTPUT_SOURCE_ONLY");
    const full = await readGrokMetadata(source, { fullSummaryFields: true });
    expect(full.metadata?.customTitle).toBe("T".repeat(5_000));
    expect(full.metadata?.summary).toBe("🙂".repeat(5_000));
    expect(full.metadata?.firstPrompt).toBe(hugePrompt);
    expect(full.metadata?.allUserText).toBe(result.metadata?.allUserText);
    expect(full.metadata?.boundedFields).toEqual(["allUserText"]);
    expect(full.metadata?.storageTruncatedFields).toEqual([]);
    expect(SafeJSON.stringify(full.metadata, { strict: true })).not.toContain("GROK_TOOL_OUTPUT_SOURCE_ONLY");
});

test("partial metadata preserves valid fields and marks text and date uncertainty", async () => {
    const home = mkdtempSync(join(tmpdir(), "gt-grok-partial-"));
    const root = join(home, "sessions");
    const directory = join(root, encodeURIComponent(CWD), SESSION_ID);
    mkdirSync(directory, { recursive: true });
    const chatPath = join(directory, "chat_history.jsonl");
    writeFileSync(
        chatPath,
        `${line({
            type: "user",
            timestamp: "2026-09-01T10:00:00.000Z",
            content: [{ type: "text", text: "<user_query>usable query</user_query>" }],
        })}{"type":"assistant","content":`
    );
    const source: NativeSessionSource<"grok"> = {
        kind: "grok",
        root,
        sourceHome: home,
        filePath: chatPath,
        dataPaths: [chatPath],
        metadataPaths: [],
    };

    const result = await readGrokMetadata(source);

    expect(result.metadata?.nativeId).toBe(SESSION_ID);
    expect(result.metadata?.firstPrompt).toBe("usable query");
    expect(result.complete).toBe(false);
    expect(result.issues.map((entry) => entry.message)).toEqual(["Partial final record at line 2"]);
    expect(result.metadata?.boundedFields).toEqual([
        "customTitle",
        "summary",
        "firstPrompt",
        "allUserText",
        "firstTimestamp",
        "lastTimestamp",
    ]);
    expect(result.issues[0]?.message).not.toContain('{"type"');
});

test("the operations factory binds metadata, scan, and selected reads", async () => {
    const home = mkdtempSync(join(tmpdir(), "gt-grok-operations-"));
    const root = join(home, "sessions");
    const directory = join(root, encodeURIComponent(CWD), SESSION_ID);
    mkdirSync(directory, { recursive: true });
    const chatPath = join(directory, "chat_history.jsonl");
    const message = SafeJSON.stringify(
        { type: "user", content: [{ type: "text", text: "<user_query>factory query</user_query>" }] },
        { strict: true }
    );
    writeFileSync(chatPath, message);
    const source: NativeSessionSource<"grok"> = {
        kind: "grok",
        root,
        sourceHome: home,
        filePath: chatPath,
        dataPaths: [chatPath],
        metadataPaths: [],
    };
    const operations = createGrokHistoryOperations();
    const metadata = await operations.readMetadata(source);
    const scanned = [];
    for await (const record of operations.scan(source)) {
        scanned.push(record);
    }
    const selected = await operations.readRecords(source, { locators: ["jsonl:1"] });

    expect(operations.parserVersion).toBe("3");
    expect(metadata.metadata?.firstPrompt).toBe("factory query");
    expect(metadata.metadata?.boundedFields).toEqual(["firstTimestamp", "lastTimestamp"]);
    expect(scanned.map((record) => record.locator)).toEqual(["jsonl:1"]);
    expect(selected.records.map((record) => record.original)).toEqual([message]);
});

test("malformed-only chat cannot become valid empty metadata", async () => {
    const home = mkdtempSync(join(tmpdir(), "gt-grok-malformed-only-"));
    const root = join(home, "sessions");
    const directory = join(root, encodeURIComponent(CWD), SESSION_ID);
    mkdirSync(directory, { recursive: true });
    const chatPath = join(directory, "chat_history.jsonl");
    writeFileSync(chatPath, '{"type":"user","content":');
    const source: NativeSessionSource<"grok"> = {
        kind: "grok",
        root,
        sourceHome: home,
        filePath: chatPath,
        dataPaths: [chatPath],
        metadataPaths: [],
    };

    const result = await readGrokMetadata(source);

    expect(result.metadata).toBeNull();
    expect(result.complete).toBe(false);
    expect(result.issues.map((entry) => entry.message)).toEqual(["Partial final record at line 1"]);
});

test("summaryless fallback titles use the byte cap and invalid dates stay uncertain", async () => {
    const home = mkdtempSync(join(tmpdir(), "gt-grok-title-date-bounds-"));
    const root = join(home, "sessions");
    const directory = join(root, encodeURIComponent(CWD), SESSION_ID);
    mkdirSync(directory, { recursive: true });
    const chatPath = join(directory, "chat_history.jsonl");
    writeFileSync(
        chatPath,
        line({
            type: "user",
            timestamp: "not-a-date",
            content: [{ type: "text", text: `<user_query>${"T".repeat(5_000)}</user_query>` }],
        })
    );
    const source: NativeSessionSource<"grok"> = {
        kind: "grok",
        root,
        sourceHome: home,
        filePath: chatPath,
        dataPaths: [chatPath],
        metadataPaths: [],
    };

    const result = await readGrokMetadata(source);

    expect(result.complete).toBe(true);
    expect(Buffer.byteLength(result.metadata?.customTitle ?? "", "utf8")).toBe(4_096);
    expect(result.metadata?.firstTimestamp).toBeNull();
    expect(result.metadata?.lastTimestamp).toBeUndefined();
    expect(result.metadata?.boundedFields).toEqual(["customTitle", "firstTimestamp", "lastTimestamp"]);
});

test("summary timestamps remain the metadata range around chat records", async () => {
    const home = mkdtempSync(join(tmpdir(), "gt-grok-summary-range-"));
    const root = join(home, "sessions");
    const directory = join(root, encodeURIComponent(CWD), SESSION_ID);
    mkdirSync(directory, { recursive: true });
    const chatPath = join(directory, "chat_history.jsonl");
    const summaryPath = join(directory, "summary.json");
    writeFileSync(
        chatPath,
        line({
            type: "user",
            timestamp: "2026-09-01T10:05:00.000Z",
            content: [{ type: "text", text: "<user_query>range query</user_query>" }],
        })
    );
    writeFileSync(
        summaryPath,
        SafeJSON.stringify(
            {
                info: { id: SESSION_ID, cwd: CWD },
                generated_title: "Range title",
                session_summary: "Range summary",
                created_at: "2026-09-01T10:00:00.000Z",
                updated_at: "2026-09-01T10:10:00.000Z",
            },
            { strict: true }
        )
    );
    const source: NativeSessionSource<"grok"> = {
        kind: "grok",
        root,
        sourceHome: home,
        filePath: summaryPath,
        dataPaths: [chatPath],
        metadataPaths: [summaryPath],
    };

    const result = await readGrokMetadata(source);

    expect(result.metadata?.firstTimestamp).toBe("2026-09-01T10:00:00.000Z");
    expect(result.metadata?.lastTimestamp).toBe("2026-09-01T10:10:00.000Z");
    expect(result.metadata?.customTitle).toBe("Range title");
    expect(result.metadata?.summary).toBe("Range summary");
});

// Re-homed from grok-sessions.test.ts, which only reached this through a wrapper that had no
// production caller. The wrapper's own JSON-parsing case went with it.
test("user-query extraction pulls the tagged query and skips harness info blobs", () => {
    expect(
        extractGrokUserQueriesFromRecord({
            type: "user",
            content: [{ type: "text", text: "<user_query>\nrestore cmux panes\n</user_query>" }],
        })
    ).toEqual(["restore cmux panes"]);

    expect(
        extractGrokUserQueriesFromRecord({
            type: "user",
            content: [{ type: "text", text: "<user_info>\nOS Version: macos\n</user_info>" }],
        })
    ).toEqual([]);
});

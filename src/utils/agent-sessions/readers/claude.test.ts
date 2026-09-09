import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import type { NativeSessionSource } from "../types";
import { createClaudeHistoryOperations, readClaudeMetadata, readClaudeRecords, scanClaudeRecords } from "./claude";

const MAIN_ID = "11111111-2222-4333-8444-555555555555";

function fixture(name = `${MAIN_ID}.jsonl`): { path: string; source: NativeSessionSource<"claude"> } {
    const home = mkdtempSync(join(tmpdir(), "gt-claude-compact-"));
    const root = join(home, "projects");
    const projectDirectory = "-projects-shop";
    const directory = join(root, projectDirectory);
    mkdirSync(directory, { recursive: true });
    const path = join(directory, name);
    return {
        path,
        source: {
            kind: "claude",
            root,
            sourceHome: home,
            filePath: path,
            dataPaths: [path],
            metadataPaths: [],
        },
    };
}

function jsonl(...records: object[]): string {
    return `${records.map((record) => SafeJSON.stringify(record, { strict: true })).join("\n")}\n`;
}

test("metadata bounds Unicode fields without retaining large tool output", async () => {
    const { path, source } = fixture();
    const hiddenToolPayload = `TOOL_OUTPUT_MUST_STAY_SOURCE_ONLY_${"x".repeat(1024 * 1024)}`;
    const firstPrompt = `prompt-${"🙂".repeat(5_000)}`;
    writeFileSync(
        path,
        jsonl(
            {
                type: "user",
                sessionId: MAIN_ID,
                cwd: "/projects/shop",
                gitBranch: "feature/refunds",
                timestamp: "2026-09-01T10:00:00.000Z",
                message: { content: firstPrompt },
            },
            {
                type: "user",
                sessionId: MAIN_ID,
                timestamp: "2026-09-01T10:01:00.000Z",
                message: {
                    content: [
                        {
                            type: "tool_result",
                            tool_use_id: "tool-1",
                            content: hiddenToolPayload,
                        },
                    ],
                },
            },
            {
                type: "user",
                sessionId: MAIN_ID,
                timestamp: "2026-09-01T10:02:00.000Z",
                message: { content: "LATER_USER_QUERY_MUST_STAY_OUTSIDE_COLLECTED_CORPUS" },
            },
            { type: "custom-title", customTitle: "T".repeat(5_000), sessionId: MAIN_ID },
            { type: "summary", summary: "🙂".repeat(5_000) }
        )
    );

    const result = await readClaudeMetadata(source);

    expect(result.complete).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.metadata?.nativeId).toBe(MAIN_ID);
    expect(result.metadata?.sessionId).toBe(MAIN_ID);
    expect(result.metadata?.resumeMode).toBe("native");
    expect(result.metadata?.project).toBe("shop");
    expect(result.metadata?.boundedFields).toEqual(["customTitle", "summary", "firstPrompt", "allUserText"]);
    expect(result.metadata?.storageTruncatedFields).toEqual(["customTitle", "summary", "firstPrompt"]);
    expect(Buffer.byteLength(result.metadata?.customTitle ?? "", "utf8")).toBe(4_096);
    expect(Buffer.byteLength(result.metadata?.summary ?? "", "utf8")).toBe(16_384);
    expect(Buffer.byteLength(result.metadata?.firstPrompt ?? "", "utf8")).toBeLessThanOrEqual(16_384);
    expect(result.metadata?.firstPrompt).not.toContain("�");
    expect(result.metadata?.allUserText?.length).toBe(5_000);
    expect(SafeJSON.stringify(result.metadata)).not.toContain("TOOL_OUTPUT_MUST_STAY_SOURCE_ONLY");
    const full = await readClaudeMetadata(source, { fullSummaryFields: true });
    expect(full.metadata?.customTitle).toBe("T".repeat(5_000));
    expect(full.metadata?.summary).toBe("🙂".repeat(5_000));
    expect(full.metadata?.firstPrompt).toBe(firstPrompt);
    expect(full.metadata?.allUserText).toBe(result.metadata?.allUserText);
    expect(full.metadata?.allUserText).not.toContain("LATER_USER_QUERY_MUST_STAY_OUTSIDE_COLLECTED_CORPUS");
    expect(full.metadata?.boundedFields).toEqual(["allUserText"]);
    expect(full.metadata?.storageTruncatedFields).toEqual([]);
    expect(SafeJSON.stringify(full.metadata)).not.toContain("TOOL_OUTPUT_MUST_STAY_SOURCE_ONLY");
});

test("scan preserves original record boundaries and Claude searchable fields", async () => {
    const { path, source } = fixture();
    const rows = [
        { type: "custom-title", customTitle: "Refund scan", sessionId: MAIN_ID },
        { type: "summary", summary: "Refund scan summary" },
        {
            type: "queue-operation",
            operation: "enqueue",
            sessionId: MAIN_ID,
            timestamp: "2026-09-01T10:01:00.000Z",
            content: "Queued follow-up",
        },
        {
            type: "progress",
            sessionId: MAIN_ID,
            timestamp: "2026-09-01T10:01:30.000Z",
            data: { type: "bash_progress", output: "still running" },
        },
        {
            type: "assistant",
            sessionId: MAIN_ID,
            timestamp: "2026-09-01T10:02:00.000Z",
            message: {
                content: [
                    { type: "text", text: "Invoice answer" },
                    { type: "thinking", thinking: "Inspect rounding" },
                    {
                        type: "tool_use",
                        id: "tool-1",
                        name: "Edit",
                        input: {
                            file_path: "src/invoice.ts",
                            new_string: `ALPHA-${"a".repeat(3_000)}-AFTER_FIELD_LIMIT`,
                            nested: { command: `BETA-${"b".repeat(3_000)}` },
                            extra: `GAMMA-${"c".repeat(5_000)}`,
                        },
                    },
                ],
            },
        },
        {
            type: "user",
            sessionId: MAIN_ID,
            timestamp: "2026-09-01T10:03:00.000Z",
            message: {
                content: [{ type: "tool_result", tool_use_id: "tool-1", content: "Edited invoice successfully" }],
            },
        },
        {
            type: "user",
            sessionId: MAIN_ID,
            timestamp: "2026-09-01T10:04:00.000Z",
            message: { content: "Please discuss docs/not-a-tool.md without opening it" },
        },
    ];
    writeFileSync(path, jsonl(...rows));

    const records = [];
    for await (const record of scanClaudeRecords(source)) {
        records.push(record);
    }

    expect(records.map((record) => [record.position, record.locator, record.entries.length])).toEqual([
        [0, "jsonl:1", 1],
        [1, "jsonl:2", 1],
        [2, "jsonl:3", 1],
        [3, "jsonl:4", 0],
        [4, "jsonl:5", 3],
        [5, "jsonl:6", 1],
        [6, "jsonl:7", 1],
    ]);
    expect(records[0]?.entries[0]?.text).toBe("Refund scan");
    expect(records[1]?.entries[0]?.text).toBe("Refund scan summary");
    expect(records[2]?.entries[0]?.text).toBe("Queued follow-up");
    expect(records[3]?.original).toBe(SafeJSON.stringify(rows[3], { strict: true }));
    expect(records[0]?.metadataChanges).toEqual({ sessionId: MAIN_ID, customTitle: "Refund scan" });
    expect(records[1]?.metadataChanges).toEqual({ summary: "Refund scan summary" });
    expect(records[3]?.timestamp).toBe("2026-09-01T10:01:30.000Z");
    expect(records[4]?.role).toBe("assistant");
    expect(records[4]?.entries.map((entry) => entry.role)).toEqual(["assistant", "thinking", "tool"]);
    const toolInput = records[4]?.entries[2];
    expect(toolInput?.tool).toBe("Edit");
    expect(toolInput?.toolEvent).toBe("call");
    expect(toolInput?.inputText).toBe(toolInput?.searchText);
    expect(toolInput?.paths).toEqual(["src/invoice.ts"]);
    expect(toolInput?.searchText).toContain("ALPHA-");
    expect(toolInput?.searchText).not.toContain("AFTER_FIELD_LIMIT");
    expect((toolInput?.searchText?.length ?? 0) <= 8_003).toBe(true);
    expect(records[5]?.entries[0]?.tool).toBe("Edit");
    expect(records[5]?.entries[0]?.toolEvent).toBe("result");
    expect("inputText" in records[5]!.entries[0]!).toBe(false);
    expect(records[5]?.entries[0]?.paths).toEqual(["src/invoice.ts"]);
    expect(records[6]?.entries[0]?.paths).toEqual([]);
});

test("selected record reads retain only requested originals and report incomplete coverage", async () => {
    const { path, source } = fixture();
    const selectedTitle = SafeJSON.stringify(
        { type: "custom-title", customTitle: "Selected title", sessionId: MAIN_ID },
        { strict: true }
    );
    const selectedUser = SafeJSON.stringify(
        {
            type: "user",
            sessionId: MAIN_ID,
            timestamp: "2026-09-01T10:05:00.000Z",
            message: { content: "Selected Unicode 🙂" },
        },
        { strict: true }
    );
    writeFileSync(
        path,
        [
            SafeJSON.stringify({ type: "summary", summary: "not selected" }, { strict: true }),
            selectedTitle,
            '{"type":"user","message":',
            selectedUser,
            '{"type":"assistant"',
        ].join("\n")
    );

    const result = await readClaudeRecords(source, { locators: ["jsonl:4", "jsonl:2"] });

    expect(result.records.map((record) => [record.locator, record.original])).toEqual([
        ["jsonl:2", selectedTitle],
        ["jsonl:4", selectedUser],
    ]);
    expect(result.complete).toBe(false);
    expect(result.issues.map((issue) => issue.message)).toEqual([
        "Malformed record at line 3",
        "Partial final record at line 5",
    ]);
    expect(result.issues.some((issue) => issue.message.includes('{"type"'))).toBe(false);
});

test("large metadata reads preserve head and tail fields with a bounded search corpus", async () => {
    const { path, source } = fixture();
    const head = [
        SafeJSON.stringify(
            {
                type: "user",
                sessionId: MAIN_ID,
                cwd: "/projects/shop",
                timestamp: "2026-09-01T08:00:00.000Z",
                message: { content: "first bounded prompt" },
            },
            { strict: true }
        ),
        ...Array.from({ length: 199 }, (_, index) =>
            SafeJSON.stringify({ type: "progress", data: { type: "query_update", index } }, { strict: true })
        ),
    ];
    const skippedMiddle = SafeJSON.stringify(
        { type: "progress", data: { type: "bash_progress", output: "m".repeat(11 * 1024 * 1024) } },
        { strict: true }
    );
    const tailTitle = SafeJSON.stringify(
        { type: "custom-title", customTitle: "Latest tail title", sessionId: MAIN_ID },
        { strict: true }
    );
    const tailSummary = SafeJSON.stringify({ type: "summary", summary: "Latest tail summary" }, { strict: true });
    writeFileSync(path, `${head.join("\n")}\n${skippedMiddle}\n${tailTitle}\n${tailSummary}\n`);

    const result = await readClaudeMetadata(source);

    expect(result.complete).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.metadata?.boundedFields).toEqual([
        "customTitle",
        "summary",
        "firstPrompt",
        "allUserText",
        "firstTimestamp",
        "lastTimestamp",
    ]);
    expect(result.metadata?.storageTruncatedFields).toEqual([]);
    expect(result.metadata?.firstPrompt).toBe("first bounded prompt");
    expect(result.metadata?.customTitle).toBe("Latest tail title");
    expect(result.metadata?.summary).toBe("Latest tail summary");
});

test("compact operations factory binds metadata, scan, and selected-record reads", async () => {
    const { path, source } = fixture();
    writeFileSync(
        path,
        jsonl({
            type: "user",
            sessionId: MAIN_ID,
            timestamp: "2026-09-01T11:00:00.000Z",
            message: { content: "factory-bound prompt" },
        })
    );
    const operations = createClaudeHistoryOperations();
    const metadata = await operations.readMetadata(source);
    const scanned = [];
    for await (const record of operations.scan(source)) {
        scanned.push(record);
    }
    const selected = await operations.readRecords(source, { locators: ["jsonl:1"] });

    expect(metadata.metadata?.firstPrompt).toBe("factory-bound prompt");
    expect(scanned.map((record) => record.locator)).toEqual(["jsonl:1"]);
    expect(selected.records[0]?.entries[0]?.text).toBe("factory-bound prompt");
});

test("subagent metadata separates the public parent ID from unsupported native resume identity", async () => {
    const { path, source } = fixture("agent-helper.jsonl");
    writeFileSync(
        path,
        jsonl({
            type: "assistant",
            sessionId: MAIN_ID,
            isSidechain: true,
            cwd: "/projects/shop",
            timestamp: "2026-09-01T11:05:00.000Z",
            message: { content: [{ type: "text", text: "helper response" }] },
        })
    );

    const result = await readClaudeMetadata(source);

    expect(result.metadata?.sessionId).toBe(MAIN_ID);
    expect(result.metadata?.nativeId).toBe("-projects-shop/agent-helper");
    expect(result.metadata?.parentNativeId).toBe(MAIN_ID);
    expect(result.metadata?.resumeMode).toBe("unsupported");
    expect(result.metadata?.isSubagent).toBe(true);
});

test("malformed-only sources cannot replace metadata with a valid empty record", async () => {
    const { path, source } = fixture();
    writeFileSync(path, '{"type":"user","message":\n');
    const scanIssues: string[] = [];
    const records = [];
    for await (const record of scanClaudeRecords(source, {
        onIssue: (issue) => scanIssues.push(issue.message),
    })) {
        records.push(record);
    }

    const result = await readClaudeMetadata(source);

    expect(records).toEqual([]);
    expect(scanIssues).toEqual(["Malformed record at line 1"]);
    expect(result.metadata).toBeNull();
    expect(result.complete).toBe(false);
    expect(result.issues.map((issue) => issue.message)).toEqual(["Malformed record at line 1"]);
});

test("missing metadata sources return bounded incomplete results", async () => {
    const { source } = fixture();

    const result = await readClaudeMetadata(source);

    expect(result).toEqual({
        metadata: null,
        issues: [{ path: source.filePath, message: "Source missing" }],
        complete: false,
    });
});

test("valid JSON at EOF remains a complete source record without a final newline", async () => {
    const { path, source } = fixture();
    const original = SafeJSON.stringify(
        {
            type: "user",
            sessionId: MAIN_ID,
            timestamp: "2026-09-01T12:00:00.000Z",
            message: { content: "complete EOF prompt" },
        },
        { strict: true }
    );
    writeFileSync(path, original);
    const issues: string[] = [];
    const records = [];
    for await (const record of scanClaudeRecords(source, {
        onIssue: (issue) => issues.push(issue.message),
    })) {
        records.push(record);
    }

    expect(records).toHaveLength(1);
    expect(records[0]?.original).toBe(original);
    expect(records[0]?.entries[0]?.text).toBe("complete EOF prompt");
    expect(issues).toEqual([]);
});

test("record positions stay dense across blank and malformed physical lines", async () => {
    const { path, source } = fixture();
    const first = SafeJSON.stringify(
        { type: "user", sessionId: MAIN_ID, message: { content: "first valid record" } },
        { strict: true }
    );
    // biome-ignore format: Preserve the assertion-input snapshot witnessed by the TDD gate.
    const second = SafeJSON.stringify(
        { type: "assistant", sessionId: MAIN_ID, message: { content: [{ type: "text", text: "second valid record" }] } },
        { strict: true }
    );
    writeFileSync(path, ["", first, '{"type":"user"', "", second, ""].join("\n"));
    const issues: string[] = [];
    const records = [];
    for await (const record of scanClaudeRecords(source, {
        onIssue: (issue) => issues.push(issue.message),
    })) {
        records.push(record);
    }

    expect(records.map((record) => [record.position, record.locator, record.entries[0]?.line])).toEqual([
        [0, "jsonl:2", 2],
        [1, "jsonl:5", 5],
    ]);
    expect(issues).toEqual(["Malformed record at line 3"]);
});

test("an unparsable timestamp never becomes the session date", async () => {
    // `new Date("later")` is Invalid Date, and every NaN comparison is false, so storing the raw
    // string let the session pass every --since and --until instead of sorting as undated.
    const { path, source } = fixture();
    writeFileSync(
        path,
        jsonl(
            { type: "user", timestamp: "later", message: { role: "user", content: "first" } },
            { type: "user", timestamp: "2026-09-01T10:00:00.000Z", message: { role: "user", content: "next" } }
        )
    );

    const result = await readClaudeMetadata(source);

    expect(result.metadata?.firstTimestamp).toBe("2026-09-01T10:00:00.000Z");
    expect(result.metadata?.lastTimestamp).toBe("2026-09-01T10:00:00.000Z");
});

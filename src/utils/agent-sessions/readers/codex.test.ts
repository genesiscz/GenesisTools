import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import type { NativeSessionSource } from "../types";
import {
    createCodexHistoryOperations,
    readCodexMetadata,
    readCodexProjectionFingerprint,
    readCodexRecords,
    scanCodexRecords,
} from "./codex";

const CHILD_ID = "11111111-2222-4333-8444-555555555555";
const PARENT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function line(record: object): string {
    return `${SafeJSON.stringify(record, { strict: true })}\n`;
}
function sha256(path: string): string {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
}

test("the first native header owns child identity and native metadata lookup", async () => {
    const home = mkdtempSync(join(tmpdir(), "gt-codex-compact-"));
    const root = join(home, "sessions");
    mkdirSync(root);
    const path = join(root, `rollout-parent-name-${PARENT_ID}.jsonl`);
    writeFileSync(
        path,
        line({
            type: "session_meta",
            timestamp: "2026-09-01T10:00:00.000Z",
            payload: {
                id: CHILD_ID,
                session_id: PARENT_ID,
                cwd: "/projects/child",
                history_mode: "legacy",
                source: { subagent: { thread_spawn: { parent_thread_id: PARENT_ID } } },
                git: { branch: "child-branch" },
            },
        }) +
            line({
                type: "session_meta",
                timestamp: "2026-08-31T09:00:00.000Z",
                payload: {
                    id: PARENT_ID,
                    cwd: "/projects/parent",
                    history_mode: "paginated",
                    git: { branch: "parent-branch" },
                },
            }) +
            line({
                type: "response_item",
                timestamp: "2026-09-01T10:05:00.000Z",
                payload: {
                    type: "message",
                    role: "user",
                    content: [{ type: "input_text", text: "child prompt" }],
                },
            })
    );
    const statePath = join(home, "state_5.sqlite");
    const state = new Database(statePath);
    state.run(
        "CREATE TABLE threads (id TEXT, title TEXT, cwd TEXT, created_at INTEGER, updated_at INTEGER, archived INTEGER)"
    );
    state.run("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?)", [
        CHILD_ID,
        "Child native title",
        "/projects/child-state",
        1_788_255_400,
        1_788_255_700,
        1,
    ]);
    state.run("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?)", [
        PARENT_ID,
        "Parent native title",
        "/projects/parent-state",
        1_788_000_000,
        1_788_000_001,
        0,
    ]);
    state.close();
    const source: NativeSessionSource<"codex"> = {
        kind: "codex",
        root,
        sourceHome: home,
        filePath: path,
        dataPaths: [path],
        metadataPaths: [statePath],
        metadata: {
            sessionId: PARENT_ID,
            title: "Filename-derived parent title",
            cwd: "/projects/parent-derived",
        },
    };

    const result = await readCodexMetadata(source);

    expect(result.complete).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.metadata).toMatchObject({
        nativeId: CHILD_ID,
        sessionId: CHILD_ID,
        parentNativeId: PARENT_ID,
        customTitle: "Child native title",
        firstPrompt: "child prompt",
        cwd: "/projects/child",
        gitBranch: "child-branch",
        archived: true,
        isSubagent: true,
        resumeMode: "native",
        sourceHome: home,
        root,
        firstTimestamp: "2026-09-01T10:00:00.000Z",
        lastTimestamp: "2026-09-01T10:05:00.000Z",
    });
    expect(result.metadata?.customTitle).not.toContain("Parent");
    const records = await Array.fromAsync(scanCodexRecords(source));
    expect(records.filter((record) => record.metadataChanges)).toEqual([]);
    expect(records[0]?.role).toBe("system");
    expect(records[1]?.role).toBe("system");
});

test("legacy scans preserve valid record positions and tool call associations", async () => {
    const home = mkdtempSync(join(tmpdir(), "gt-codex-legacy-"));
    const root = join(home, "sessions");
    mkdirSync(root);
    const path = join(root, `rollout-${CHILD_ID}.jsonl`);
    const header = SafeJSON.stringify(
        { type: "session_meta", payload: { id: CHILD_ID, cwd: "/projects/child", history_mode: "legacy" } },
        { strict: true }
    );
    const user = SafeJSON.stringify(
        {
            type: "response_item",
            timestamp: "2026-09-01T10:01:00.000Z",
            payload: {
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: "Inspect Unicode 🙂" }],
            },
        },
        { strict: true }
    );
    const reasoning = SafeJSON.stringify(
        {
            type: "response_item",
            payload: {
                type: "reasoning",
                summary: [{ type: "summary_text", text: "Need source evidence" }],
            },
        },
        { strict: true }
    );
    const call = SafeJSON.stringify(
        {
            type: "response_item",
            payload: {
                type: "function_call",
                name: "exec_command",
                call_id: "call-1",
                arguments: '{"cmd":"git show abcdef123456 src/invoice.ts"}',
            },
        },
        { strict: true }
    );
    const output = SafeJSON.stringify(
        {
            type: "response_item",
            payload: {
                type: "function_call_output",
                call_id: "call-1",
                output: "invoice result",
            },
        },
        { strict: true }
    );
    const assistant = SafeJSON.stringify(
        {
            type: "response_item",
            payload: {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "Done without trailing newline" }],
            },
        },
        { strict: true }
    );
    writeFileSync(path, [header, '{"type":"broken"', user, reasoning, call, output, assistant].join("\n"));
    const source: NativeSessionSource<"codex"> = {
        kind: "codex",
        root,
        sourceHome: home,
        filePath: path,
        dataPaths: [path],
        metadataPaths: [],
    };
    const issueMessages: string[] = [];
    const records = [];
    for await (const record of scanCodexRecords(source, {
        onIssue: (issue) => issueMessages.push(issue.message),
    })) {
        records.push(record);
    }

    expect(records.map((record) => [record.position, record.locator, record.entries.length])).toEqual([
        [0, "jsonl:1", 0],
        [1, "jsonl:3", 1],
        [2, "jsonl:4", 1],
        [3, "jsonl:5", 1],
        [4, "jsonl:6", 1],
        [5, "jsonl:7", 1],
    ]);
    expect(records[1]?.entries[0]).toMatchObject({ role: "user", text: "Inspect Unicode 🙂", line: 3 });
    expect(records[0]).toMatchObject({ role: "system" });
    expect(records[0]?.metadataChanges).toBeUndefined();
    expect(records[1]).toMatchObject({ timestamp: "2026-09-01T10:01:00.000Z", role: "user" });
    expect(records[2]?.entries[0]).toMatchObject({ role: "thinking", text: "Need source evidence", line: 4 });
    expect(records[3]?.entries[0]).toMatchObject({
        role: "tool",
        tool: "exec_command",
        toolEvent: "call",
        inputText: "git show abcdef123456 src/invoice.ts",
        line: 5,
        paths: ["src/invoice.ts"],
        commits: ["abcdef123456"],
    });
    expect(records[4]?.entries[0]).toMatchObject({
        role: "tool",
        tool: "exec_command",
        toolEvent: "result",
        text: "invoice result",
        line: 6,
        paths: ["src/invoice.ts"],
    });
    expect("inputText" in records[4]!.entries[0]!).toBe(false);
    expect(records[5]?.entries[0]?.text).toBe("Done without trailing newline");
    expect(records[5]?.original).toBe(assistant);
    expect(issueMessages).toEqual(["Malformed record at line 2"]);
    expect(issueMessages.join("\n")).not.toContain('{"type"');
});

test("selected legacy reads return exact originals and incomplete coverage", async () => {
    const home = mkdtempSync(join(tmpdir(), "gt-codex-selected-"));
    const root = join(home, "sessions");
    mkdirSync(root);
    const path = join(root, `rollout-${CHILD_ID}.jsonl`);
    const header = SafeJSON.stringify(
        { type: "session_meta", payload: { id: CHILD_ID, cwd: "/projects/child", history_mode: "legacy" } },
        { strict: true }
    );
    const selected = SafeJSON.stringify(
        {
            type: "response_item",
            payload: {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "Selected context 🙂" }],
            },
        },
        { strict: true }
    );
    writeFileSync(path, [header, '{"broken":', selected].join("\n"));
    const source: NativeSessionSource<"codex"> = {
        kind: "codex",
        root,
        sourceHome: home,
        filePath: path,
        dataPaths: [path],
        metadataPaths: [],
    };

    const result = await readCodexRecords(source, {
        locators: ["jsonl:3", "jsonl:99"],
    });

    expect(result.records.map((record) => [record.position, record.locator, record.original])).toEqual([
        [1, "jsonl:3", selected],
    ]);
    expect(result.complete).toBe(false);
    expect(result.issues.map((issue) => issue.message)).toEqual([
        "Malformed record at line 2",
        "Record locator not found: jsonl",
    ]);
    expect(result.issues.map((issue) => issue.message).join("\n")).not.toContain('{"broken"');
});

test("paginated scans stay thread-scoped, ordered, source-backed, and read-only", async () => {
    const home = mkdtempSync(join(tmpdir(), "gt-codex-projection-"));
    const root = join(home, "sessions");
    mkdirSync(root);
    const path = join(root, `rollout-${CHILD_ID}.jsonl`);
    writeFileSync(
        path,
        line({
            type: "session_meta",
            payload: { id: CHILD_ID, cwd: "/projects/child", history_mode: "paginated" },
        }) +
            line({
                type: "session_meta",
                payload: { id: PARENT_ID, cwd: "/projects/parent", history_mode: "legacy" },
            })
    );
    const projectionPath = join(home, "thread_history_1.sqlite");
    const projection = new Database(projectionPath);
    projection.run(
        "CREATE TABLE thread_items (thread_id TEXT, rollout_ordinal INTEGER, created_at_ms INTEGER, item_json TEXT, updated_at_ordinal INTEGER)"
    );
    const projected = [
        {
            ordinal: 7,
            item: {
                type: "collabAgentToolCall",
                tool: "spawn_agent",
                prompt: "Review invoice flow",
                agentsStates: { reviewer: "done" },
            },
        },
        {
            ordinal: 2,
            item: {
                type: "commandExecution",
                command: "git show abcdef123456 src/invoice.ts",
                aggregatedOutput: "rounding verified",
            },
        },
        {
            ordinal: 4,
            item: {
                type: "mcpToolCall",
                tool: "github/search",
                arguments: { query: "invoice" },
                result: { content: "issue found" },
            },
        },
        {
            ordinal: 1,
            item: { type: "userMessage", content: [{ type: "input_text", text: "Fix invoice 🙂" }] },
        },
        {
            ordinal: 3,
            item: { type: "fileChange", changes: [{ path: "src/invoice.ts", kind: { type: "update" } }] },
        },
        {
            ordinal: 5,
            item: { type: "reasoning", summary: ["check cents"], content: ["use integers"] },
        },
        {
            ordinal: 6,
            item: { type: "agentMessage", text: "Invoice fixed" },
        },
    ];
    for (const row of projected) {
        projection.run("INSERT INTO thread_items VALUES (?, ?, ?, ?, ?)", [
            CHILD_ID,
            row.ordinal,
            1_788_257_400_000 + row.ordinal,
            SafeJSON.stringify(row.item, { strict: true }),
            20 + row.ordinal,
        ]);
    }
    projection.run("INSERT INTO thread_items VALUES (?, ?, ?, ?, ?)", [
        PARENT_ID,
        1,
        1_788_257_400_000,
        SafeJSON.stringify({ type: "agentMessage", text: "parent secret" }, { strict: true }),
        1,
    ]);
    projection.close();
    const source: NativeSessionSource<"codex"> = {
        kind: "codex",
        root,
        sourceHome: home,
        filePath: path,
        dataPaths: [path],
        metadataPaths: [projectionPath],
    };
    const before = [sha256(path), sha256(projectionPath)];
    const records = [];
    for await (const record of scanCodexRecords(source)) {
        records.push(record);
    }

    expect(records.map((record) => [record.position, record.locator])).toEqual([
        [0, "projection:0:1:21"],
        [1, "projection:0:2:22"],
        [2, "projection:0:3:23"],
        [3, "projection:0:4:24"],
        [4, "projection:0:5:25"],
        [5, "projection:0:6:26"],
        [6, "projection:0:7:27"],
    ]);
    expect(records.map((record) => record.role)).toEqual([
        "user",
        "tool",
        "tool",
        "tool",
        "thinking",
        "assistant",
        "tool",
    ]);
    expect(records[0]?.timestamp).toBe(new Date(1_788_257_400_001).toISOString());
    expect(records.flatMap((record) => record.entries).map((entry) => [entry.line, entry.role, entry.tool])).toEqual([
        [1, "user", undefined],
        [2, "tool", "exec_command"],
        [3, "tool", "apply_patch"],
        [4, "tool", "github/search"],
        [5, "thinking", undefined],
        [6, "assistant", undefined],
        [7, "tool", "spawn_agent"],
    ]);
    expect(records[1]?.entries[0]).toMatchObject({
        toolEvent: "call",
        inputText: "git show abcdef123456 src/invoice.ts",
        paths: ["src/invoice.ts"],
        commits: ["abcdef123456"],
    });
    expect(records[2]?.entries[0]?.paths).toEqual(["src/invoice.ts"]);
    expect(records[3]?.entries[0]).toMatchObject({
        toolEvent: "call",
        inputText: "invoice",
    });
    expect(records[3]?.entries[0]?.text).toContain("issue found");
    expect(records[4]?.entries[0]?.text).toContain("use integers");
    expect(records[6]?.entries[0]?.text).toContain("Review invoice flow");
    expect(records.flatMap((record) => record.entries).some((entry) => entry.text.includes("parent secret"))).toBe(
        false
    );
    expect([sha256(path), sha256(projectionPath)]).toEqual(before);
});

test("projection fingerprints detect same-count mutations and ignore other threads", async () => {
    const home = mkdtempSync(join(tmpdir(), "gt-codex-fingerprint-"));
    const root = join(home, "sessions");
    mkdirSync(root);
    const path = join(root, `rollout-${CHILD_ID}.jsonl`);
    writeFileSync(
        path,
        line({
            type: "session_meta",
            payload: { id: CHILD_ID, cwd: "/projects/child", history_mode: "paginated" },
        })
    );
    const projectionPath = join(home, "thread_history_1.sqlite");
    const projection = new Database(projectionPath);
    projection.run("PRAGMA journal_mode = WAL");
    projection.run(
        "CREATE TABLE thread_items (thread_id TEXT, rollout_ordinal INTEGER, created_at_ms INTEGER, item_json TEXT, updated_at_ordinal INTEGER)"
    );
    projection.run("INSERT INTO thread_items VALUES (?, 1, 1788257400000, ?, 1)", [
        CHILD_ID,
        SafeJSON.stringify({ type: "agentMessage", text: "old child text" }, { strict: true }),
    ]);
    projection.run("INSERT INTO thread_items VALUES (?, 1, 1788257400000, ?, 1)", [
        PARENT_ID,
        SafeJSON.stringify({ type: "agentMessage", text: "old parent text" }, { strict: true }),
    ]);
    const source: NativeSessionSource<"codex"> = {
        kind: "codex",
        root,
        sourceHome: home,
        filePath: path,
        dataPaths: [path],
        metadataPaths: [projectionPath],
    };

    const before = await readCodexProjectionFingerprint(source);
    projection.run("UPDATE thread_items SET item_json = ?, updated_at_ordinal = 2 WHERE thread_id = ?", [
        SafeJSON.stringify({ type: "agentMessage", text: "new parent text" }, { strict: true }),
        PARENT_ID,
    ]);
    const afterOtherThread = await readCodexProjectionFingerprint(source);
    projection.run("UPDATE thread_items SET item_json = ?, updated_at_ordinal = 2 WHERE thread_id = ?", [
        SafeJSON.stringify({ type: "agentMessage", text: "new child text" }, { strict: true }),
        CHILD_ID,
    ]);
    const afterChild = await readCodexProjectionFingerprint(source);
    projection.close();

    expect(before).toBe(afterOtherThread);
    expect(afterChild).not.toBe(before);
    expect(afterChild).toContain('"count":1');
    expect(afterChild).toContain('"revision":2');
});

test("metadata bounds Unicode fields without retaining huge tool output", async () => {
    const home = mkdtempSync(join(tmpdir(), "gt-codex-metadata-bounds-"));
    const root = join(home, "sessions");
    mkdirSync(root);
    const path = join(root, `rollout-${CHILD_ID}.jsonl`);
    const hugePrompt = `prompt-${"🙂".repeat(5_000)}`;
    const hugeOutput = `SOURCE_ONLY_TOOL_OUTPUT_${"x".repeat(1024 * 1024)}`;
    writeFileSync(
        path,
        line({
            type: "session_meta",
            timestamp: "2026-09-01T10:00:00.000Z",
            payload: { id: CHILD_ID, cwd: "/projects/child", history_mode: "legacy" },
        }) +
            line({
                type: "response_item",
                payload: {
                    type: "message",
                    role: "user",
                    content: [{ type: "input_text", text: hugePrompt }],
                },
            }) +
            line({
                type: "response_item",
                payload: {
                    type: "function_call_output",
                    call_id: "large-output",
                    output: hugeOutput,
                },
            })
    );
    const statePath = join(home, "state_5.sqlite");
    const state = new Database(statePath);
    state.run("CREATE TABLE threads (id TEXT, title TEXT, summary TEXT)");
    state.run("INSERT INTO threads VALUES (?, ?, ?)", [CHILD_ID, "T".repeat(5_000), "🙂".repeat(5_000)]);
    state.close();
    const source: NativeSessionSource<"codex"> = {
        kind: "codex",
        root,
        sourceHome: home,
        filePath: path,
        dataPaths: [path],
        metadataPaths: [statePath],
    };

    const result = await readCodexMetadata(source);

    expect(result.complete).toBe(true);
    expect(result.metadata?.boundedFields).toEqual(["customTitle", "summary", "firstPrompt", "allUserText"]);
    expect(result.metadata?.storageTruncatedFields).toEqual(["customTitle", "summary", "firstPrompt"]);
    expect(Buffer.byteLength(result.metadata?.customTitle ?? "", "utf8")).toBe(4_096);
    expect(Buffer.byteLength(result.metadata?.summary ?? "", "utf8")).toBe(16_384);
    expect(Buffer.byteLength(result.metadata?.firstPrompt ?? "", "utf8")).toBeLessThanOrEqual(16_384);
    expect(result.metadata?.firstPrompt).not.toContain("�");
    expect(result.metadata?.allUserText?.length).toBe(5_000);
    expect(SafeJSON.stringify(result.metadata, { strict: true })).not.toContain("SOURCE_ONLY_TOOL_OUTPUT");
    const full = await readCodexMetadata(source, { fullSummaryFields: true });
    expect(full.metadata?.customTitle).toBe("T".repeat(5_000));
    expect(full.metadata?.summary).toBe("🙂".repeat(5_000));
    expect(full.metadata?.firstPrompt).toBe(hugePrompt);
    expect(full.metadata?.allUserText).toBe(result.metadata?.allUserText);
    expect(full.metadata?.boundedFields).toEqual(["allUserText"]);
    expect(full.metadata?.storageTruncatedFields).toEqual([]);
    expect(SafeJSON.stringify(full.metadata, { strict: true })).not.toContain("SOURCE_ONLY_TOOL_OUTPUT");
});

test("partial metadata preserves usable fields and marks incomplete coverage", async () => {
    const home = mkdtempSync(join(tmpdir(), "gt-codex-partial-"));
    const root = join(home, "sessions");
    mkdirSync(root);
    const path = join(root, `rollout-${CHILD_ID}.jsonl`);
    writeFileSync(
        path,
        line({
            type: "session_meta",
            timestamp: "2026-09-01T10:00:00.000Z",
            payload: { id: CHILD_ID, cwd: "/projects/child", history_mode: "legacy" },
        }) +
            line({
                type: "response_item",
                timestamp: "2026-09-01T10:01:00.000Z",
                payload: {
                    type: "message",
                    role: "user",
                    content: [{ type: "input_text", text: "usable prompt" }],
                },
            }) +
            '{"type":"response_item","payload":'
    );
    const source: NativeSessionSource<"codex"> = {
        kind: "codex",
        root,
        sourceHome: home,
        filePath: path,
        dataPaths: [path],
        metadataPaths: [],
    };

    const result = await readCodexMetadata(source);

    expect(result.metadata?.nativeId).toBe(CHILD_ID);
    expect(result.metadata?.firstPrompt).toBe("usable prompt");
    expect(result.complete).toBe(false);
    expect(result.issues.map((issue) => issue.message)).toEqual(["Partial final record at line 3"]);
    expect(result.metadata?.boundedFields).toEqual([
        "customTitle",
        "summary",
        "firstPrompt",
        "allUserText",
        "firstTimestamp",
        "lastTimestamp",
    ]);
});

test("session index metadata is selected by the authoritative header id", async () => {
    const home = mkdtempSync(join(tmpdir(), "gt-codex-session-index-"));
    const root = join(home, "archived_sessions");
    mkdirSync(root);
    const path = join(root, `rollout-parent-name-${PARENT_ID}.jsonl`);
    writeFileSync(
        path,
        line({
            type: "session_meta",
            payload: {
                id: CHILD_ID,
                session_id: PARENT_ID,
                cwd: "/projects/archive-child",
                history_mode: "legacy",
            },
        })
    );
    const indexPath = join(home, "session_index.jsonl");
    writeFileSync(
        indexPath,
        line({ id: PARENT_ID, thread_name: "Parent index title", updated_at: "2026-09-01T10:00:00.000Z" }) +
            line({ id: CHILD_ID, thread_name: "Child index title", updated_at: "2026-09-01T11:00:00.000Z" })
    );
    const source: NativeSessionSource<"codex"> = {
        kind: "codex",
        root,
        sourceHome: home,
        filePath: path,
        dataPaths: [path],
        metadataPaths: [indexPath],
        metadata: {
            sessionId: PARENT_ID,
            title: "Filename parent metadata",
            cwd: "/projects/parent",
        },
    };

    const result = await readCodexMetadata(source);

    expect(result.complete).toBe(true);
    expect(result.metadata).toMatchObject({
        nativeId: CHILD_ID,
        parentNativeId: PARENT_ID,
        customTitle: "Child index title",
        cwd: "/projects/archive-child",
        archived: true,
        sourceHome: home,
    });
});

test("paginated metadata reads bounded user fields from the exact native thread", async () => {
    const home = mkdtempSync(join(tmpdir(), "gt-codex-paginated-metadata-"));
    const root = join(home, "sessions");
    mkdirSync(root);
    const path = join(root, `rollout-${CHILD_ID}.jsonl`);
    writeFileSync(
        path,
        line({
            type: "session_meta",
            timestamp: "2026-09-01T10:00:00.000Z",
            payload: { id: CHILD_ID, cwd: "/projects/child", history_mode: "paginated" },
        })
    );
    const projectionPath = join(home, "thread_history_1.sqlite");
    const projection = new Database(projectionPath);
    projection.run(
        "CREATE TABLE thread_items (thread_id TEXT, rollout_ordinal INTEGER, created_at_ms INTEGER, item_json TEXT)"
    );
    projection.run("INSERT INTO thread_items VALUES (?, 1, ?, ?)", [
        PARENT_ID,
        Date.parse("2026-09-01T10:00:30.000Z"),
        SafeJSON.stringify({ type: "userMessage", content: "parent prompt" }, { strict: true }),
    ]);
    projection.run("INSERT INTO thread_items VALUES (?, 2, ?, ?)", [
        CHILD_ID,
        Date.parse("2026-09-01T10:01:00.000Z"),
        SafeJSON.stringify(
            { type: "userMessage", content: [{ type: "input_text", text: "projected child prompt 🙂" }] },
            { strict: true }
        ),
    ]);
    projection.run("INSERT INTO thread_items VALUES (?, 3, ?, ?)", [
        CHILD_ID,
        Date.parse("2026-09-01T10:02:00.000Z"),
        SafeJSON.stringify(
            { type: "commandExecution", command: "inspect", aggregatedOutput: "PROJECTION_BODY_MUST_NOT_PERSIST" },
            { strict: true }
        ),
    ]);
    projection.close();
    const source: NativeSessionSource<"codex"> = {
        kind: "codex",
        root,
        sourceHome: home,
        filePath: path,
        dataPaths: [path],
        metadataPaths: [projectionPath],
    };

    const result = await readCodexMetadata(source);

    expect(result.complete).toBe(true);
    expect(result.metadata?.firstPrompt).toBe("projected child prompt 🙂");
    expect(result.metadata?.allUserText).toBe("projected child prompt 🙂");
    expect(result.metadata?.lastTimestamp).toBe("2026-09-01T10:02:00.000Z");
    expect(SafeJSON.stringify(result.metadata, { strict: true })).not.toContain("PROJECTION_BODY_MUST_NOT_PERSIST");
    expect(SafeJSON.stringify(result.metadata, { strict: true })).not.toContain("parent prompt");
});

test("selected reads report a missing paginated projection instead of empty success", async () => {
    const home = mkdtempSync(join(tmpdir(), "gt-codex-missing-projection-"));
    const root = join(home, "sessions");
    mkdirSync(root);
    const path = join(root, `rollout-${CHILD_ID}.jsonl`);
    writeFileSync(
        path,
        line({
            type: "session_meta",
            payload: { id: CHILD_ID, cwd: "/projects/child", history_mode: "paginated" },
        })
    );
    const source: NativeSessionSource<"codex"> = {
        kind: "codex",
        root,
        sourceHome: home,
        filePath: path,
        dataPaths: [path],
        metadataPaths: [],
    };
    const issueMessages: string[] = [];
    const result = await readCodexRecords(source, {
        locators: ["projection:0:1:1"],
        onIssue: (issue) => issueMessages.push(issue.message),
    });

    expect(result.records).toEqual([]);
    expect(result.complete).toBe(false);
    expect(result.issues.map((issue) => issue.message)).toEqual([
        "Paginated projection unavailable for native thread",
        "Record locator not found: projection",
    ]);
    expect(issueMessages).toEqual(result.issues.map((issue) => issue.message));
});

test("the operations factory binds compact metadata, scan, and selected reads", async () => {
    const home = mkdtempSync(join(tmpdir(), "gt-codex-operations-"));
    const root = join(home, "sessions");
    mkdirSync(root);
    const path = join(root, `rollout-${CHILD_ID}.jsonl`);
    const message = SafeJSON.stringify(
        {
            type: "response_item",
            payload: {
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: "factory prompt" }],
            },
        },
        { strict: true }
    );
    writeFileSync(
        path,
        line({
            type: "session_meta",
            payload: { id: CHILD_ID, cwd: "/projects/child", history_mode: "legacy" },
        }) + message
    );
    const source: NativeSessionSource<"codex"> = {
        kind: "codex",
        root,
        sourceHome: home,
        filePath: path,
        dataPaths: [path],
        metadataPaths: [],
    };
    const operations = createCodexHistoryOperations();
    const metadata = await operations.readMetadata(source);
    const records = [];
    for await (const record of operations.scan(source)) {
        records.push(record);
    }
    const selected = await operations.readRecords(source, { locators: ["jsonl:2"] });

    expect(operations.parserVersion).toBe("6");
    expect(metadata.metadata?.firstPrompt).toBe("factory prompt");
    expect(records.map((record) => record.locator)).toEqual(["jsonl:1", "jsonl:2"]);
    expect(selected.records.map((record) => record.original)).toEqual([message]);
});

function legacyFixture(rows: object[]): NativeSessionSource<"codex"> {
    const home = mkdtempSync(join(tmpdir(), "gt-codex-legacy-"));
    const root = join(home, "sessions");
    mkdirSync(root);
    const path = join(root, `rollout-2025-09-19T19-17-30-${CHILD_ID}.jsonl`);
    writeFileSync(path, rows.map(line).join(""));
    return { kind: "codex", root, sourceHome: home, filePath: path, dataPaths: [path], metadataPaths: [] };
}

test("a pre-session_meta rollout header still identifies the session", async () => {
    // Codex 2025 opened a rollout with a bare {id, timestamp, instructions} record. Rejecting it
    // reported "Native session header missing" and hid the conversation from every codex search.
    const source = legacyFixture([
        { id: CHILD_ID, timestamp: "2025-09-19T19:17:30.596Z", instructions: null },
        {
            type: "response_item",
            payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "old answer" }] },
        },
    ]);

    const result = await readCodexMetadata(source);

    expect(result.issues).toEqual([]);
    expect(result.complete).toBe(true);
    expect(result.metadata?.nativeId).toBe(CHILD_ID);
});

test("an ordinary record carrying an id is not mistaken for a legacy header", async () => {
    const source = legacyFixture([
        {
            type: "response_item",
            id: CHILD_ID,
            timestamp: "2026-09-01T10:00:00.000Z",
            instructions: null,
            payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
        },
    ]);

    const result = await readCodexMetadata(source);

    expect(result.metadata).toBeNull();
});

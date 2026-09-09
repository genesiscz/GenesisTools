import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { claudeHistoryReader, codexHistoryReader, grokHistoryReader } from "./compact-readers";
import { readCompatibilityTranscript } from "./reader-compat";
import type { NativeSessionReader } from "./types";

const ID = "11111111-2222-4333-8444-555555555555";
function lines(...records: object[]) {
    return `${records.map((record) => SafeJSON.stringify(record)).join("\n")}\n`;
}
function fixture() {
    const home = mkdtempSync(join(tmpdir(), "gt-native-reader-"));
    const root = join(home, "sessions");
    mkdirSync(root);
    return { home, root };
}

describe("native readers", () => {
    test("Codex reads assistant and tool output beyond the first eighty records with native title metadata", async () => {
        const { home, root } = fixture();
        const path = join(root, `rollout-${ID}.jsonl`);
        writeFileSync(
            path,
            lines(
                { type: "session_meta", timestamp: "2026-09-01T10:00:00Z", payload: { id: ID, cwd: "/projects/shop" } },
                ...Array.from({ length: 90 }, () => ({ type: "event_msg", payload: { type: "token_count" } })),
                {
                    type: "response_item",
                    payload: {
                        type: "message",
                        role: "assistant",
                        content: [{ type: "output_text", text: "invoice parser fixed" }],
                    },
                },
                {
                    type: "response_item",
                    payload: {
                        type: "function_call",
                        name: "exec_command",
                        call_id: "call-1",
                        arguments: '{"cmd":"git show abcdef123456 src/invoice.ts"}',
                    },
                },
                {
                    type: "response_item",
                    payload: { type: "function_call_output", call_id: "call-1", output: "refund rounding confirmed" },
                }
            )
        );
        const db = new Database(join(home, "state_5.sqlite"));
        db.run("CREATE TABLE threads (id TEXT, title TEXT, cwd TEXT, updated_at INTEGER)");
        db.run("INSERT INTO threads VALUES (?, ?, ?, ?)", [ID, "Renamed invoices", "/projects/shop", 1788257400]);
        db.close();
        const discovered = await codexHistoryReader.discover([root]);
        const result = await codexHistoryReader.read(discovered.sources[0]!);
        expect(result.session.title).toBe("Renamed invoices");
        expect(result.entries.map((entry) => entry.text).join("\n")).toContain("refund rounding confirmed");
        expect(result.entries.some((entry) => entry.tool === "exec_command" && entry.text.includes("refund"))).toBe(
            true
        );
        expect(result.entries.flatMap((entry) => entry.paths)).toContain("src/invoice.ts");
        expect(result.entries.flatMap((entry) => entry.commits)).toContain("abcdef123456");
        expect(result.session.account).toBeUndefined();
        expect(SafeJSON.parse(result.session.sourceKey!, { strict: true })).toEqual([
            "openai-sub",
            result.session.sourceHome,
            ID,
        ]);
        expect(typeof codexHistoryReader.importSession).toBe("function");
    });

    test("Grok reads chat history assistant text and tool results along with summary", async () => {
        const { root } = fixture();
        const dir = join(root, encodeURIComponent("/projects/shop"), ID);
        mkdirSync(dir, { recursive: true });
        writeFileSync(
            join(dir, "summary.json"),
            SafeJSON.stringify({
                info: { id: ID, cwd: "/projects/shop" },
                generated_title: "Invoices",
                session_summary: "Refund integration",
            })
        );
        writeFileSync(
            join(dir, "chat_history.jsonl"),
            lines(
                { type: "user", content: [{ type: "text", text: "<user_query>repair invoices</user_query>" }] },
                {
                    type: "assistant",
                    content: [
                        { type: "text", text: "rounding fixed" },
                        { type: "tool_use", name: "read_file", id: "tool-1", input: { file_path: "src/invoice.ts" } },
                    ],
                },
                {
                    type: "user",
                    content: [{ type: "tool_result", tool_use_id: "tool-1", content: "refund result verified" }],
                }
            )
        );
        const discovered = await grokHistoryReader.discover([root]);
        const result = await grokHistoryReader.read(discovered.sources[0]!);
        expect(result.session.summary).toBe("Refund integration");
        expect(result.entries.some((entry) => entry.role === "assistant" && entry.text.includes("rounding"))).toBe(
            true
        );
        expect(result.entries.some((entry) => entry.tool === "read_file" && entry.text.includes("refund result"))).toBe(
            true
        );
    });

    test("Claude keeps custom titles, thinking, tool input and subagent identity", async () => {
        const { root } = fixture();
        const dir = join(root, "project", ID, "subagents");
        mkdirSync(dir, { recursive: true });
        writeFileSync(
            join(dir, "agent-helper.jsonl"),
            lines(
                { type: "custom-title", customTitle: "Refund helper", sessionId: ID },
                {
                    type: "assistant",
                    sessionId: ID,
                    cwd: "/projects/shop",
                    isSidechain: true,
                    message: {
                        content: [
                            { type: "thinking", thinking: "private reasoning fixture" },
                            {
                                type: "tool_use",
                                name: "Edit",
                                id: "t",
                                input: { file_path: "src/invoice.ts", new_string: "rounding correction" },
                            },
                        ],
                    },
                }
            )
        );
        const discovered = await claudeHistoryReader.discover([root]);
        const result = await claudeHistoryReader.read(discovered.sources[0]!);
        expect(result.session.title).toBe("Refund helper");
        expect(result.session.isSubagent).toBe(true);
        expect(result.session.sessionId).toBe("agent-helper");
        expect(SafeJSON.parse(result.session.sourceKey!, { strict: true })).toEqual([
            "anthropic-sub",
            result.session.sourceHome,
            `project/${ID}/subagents/agent-helper`,
        ]);
        expect(result.entries.some((entry) => entry.role === "thinking")).toBe(true);
        expect(
            result.entries.some((entry) => entry.tool === "Edit" && entry.text.includes("rounding correction"))
        ).toBe(true);
        expect(result.records?.some((record) => record.data.includes("rounding correction"))).toBe(true);
    });
});

test("Claude sessions-index metadata supplies updated titles and project paths", async () => {
    const { root } = fixture();
    const project = join(root, "-projects-shop");
    mkdirSync(project);
    writeFileSync(
        join(project, `${ID}.jsonl`),
        lines({ type: "user", sessionId: ID, message: { content: "repair invoices" } })
    );
    writeFileSync(
        join(project, "sessions-index.json"),
        SafeJSON.stringify({
            version: 1,
            entries: [
                {
                    sessionId: ID,
                    customTitle: "Renamed refunds",
                    summary: "Billing report",
                    projectPath: "/projects/shop",
                    modified: "2026-09-02T12:00:00Z",
                },
            ],
        })
    );
    const discovered = await claudeHistoryReader.discover([root]);
    const result = await claudeHistoryReader.read(discovered.sources[0]!);
    expect(result.session.title).toBe("Renamed refunds");
    expect(result.session.cwd).toBe("/projects/shop");
    expect(result.session.summary).toBe("Billing report");
});

test("compatibility reads return the original prompt rather than compact metadata text", async () => {
    const { root } = fixture();
    const project = join(root, "-projects-shop");
    mkdirSync(project);
    const prompt = "p".repeat(20_000);
    writeFileSync(
        join(project, `${ID}.jsonl`),
        lines({
            type: "user",
            sessionId: ID,
            cwd: "/projects/shop",
            message: { content: prompt },
        })
    );

    const discovered = await claudeHistoryReader.discover([root]);
    const result = await claudeHistoryReader.read(discovered.sources[0]!);

    expect(result.session.prompt).toBe(prompt);
    expect(result.records?.[0]?.data).toContain(prompt);
});

test("equal Claude subagent basenames retain distinct parent-qualified source identities", async () => {
    const { root } = fixture();
    const parentIds = [ID, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"];
    for (const [project, parentId] of ["project-a", "project-b"].map((project, index) => [
        project,
        parentIds[index]!,
    ])) {
        const directory = join(root, project, parentId, "subagents");
        mkdirSync(directory, { recursive: true });
        writeFileSync(
            join(directory, "agent-helper.jsonl"),
            lines({
                type: "assistant",
                sessionId: parentId,
                cwd: `/projects/${project}`,
                isSidechain: true,
                message: { content: "helper response" },
            })
        );
    }

    const discovered = await claudeHistoryReader.discover([root]);
    const sessions = await Promise.all(discovered.sources.map((source) => claudeHistoryReader.read(source)));
    const sourceKeys = sessions.map((result) => result.session.sourceKey!);
    const nativeIds = sourceKeys.map((key) => (SafeJSON.parse(key, { strict: true }) as string[])[2]);

    expect(new Set(sessions.map((result) => result.session.sessionId))).toEqual(new Set(["agent-helper"]));
    expect(new Set(sourceKeys).size).toBe(2);
    expect(nativeIds.sort()).toEqual([
        `project-a/${parentIds[0]}/subagents/agent-helper`,
        `project-b/${parentIds[1]}/subagents/agent-helper`,
    ]);
});

test("compatibility timestamps prefer native activity and fall back to source mtime", async () => {
    const { root } = fixture();
    const nativePath = join(root, `rollout-${ID}.jsonl`);
    writeFileSync(
        nativePath,
        lines(
            {
                type: "session_meta",
                timestamp: "2026-09-01T10:00:00.000Z",
                payload: { id: ID, cwd: "/projects/shop" },
            },
            {
                type: "response_item",
                timestamp: "2026-09-02T12:00:00.000Z",
                payload: {
                    type: "message",
                    role: "assistant",
                    content: [{ type: "output_text", text: "latest activity" }],
                },
            }
        )
    );
    utimesSync(nativePath, new Date("2020-01-01T00:00:00.000Z"), new Date("2020-01-01T00:00:00.000Z"));
    const nativeSource = (await codexHistoryReader.discover([root])).sources.find(
        (source) => source.filePath === realpathSync(nativePath)
    )!;
    const nativeResult = await readCompatibilityTranscript(codexHistoryReader, nativeSource, {
        readMetadata: false,
    });

    expect(nativeResult.session.createdAt?.toISOString()).toBe("2026-09-01T10:00:00.000Z");
    expect(nativeResult.session.mtime.toISOString()).toBe("2026-09-02T12:00:00.000Z");

    const fallbackId = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
    const fallbackPath = join(root, `rollout-${fallbackId}.jsonl`);
    writeFileSync(fallbackPath, lines({ type: "session_meta", payload: { id: fallbackId, cwd: "/projects/shop" } }));
    const fallbackTime = new Date("2025-06-03T09:08:07.000Z");
    utimesSync(fallbackPath, fallbackTime, fallbackTime);
    const fallbackSource = (await codexHistoryReader.discover([root])).sources.find(
        (source) => source.filePath === realpathSync(fallbackPath)
    )!;
    const fallbackResult = await readCompatibilityTranscript(codexHistoryReader, fallbackSource, {
        readMetadata: false,
    });

    expect(fallbackResult.session.mtime.toISOString()).toBe(fallbackTime.toISOString());
});

test("compatibility reads reject a source changed between metadata and record hydration", async () => {
    // Regression test: CompactProviderHistoryRefactor final review — never combine different source revisions.
    const { root } = fixture();
    const project = join(root, "-projects-shop");
    mkdirSync(project);
    const path = join(project, `${ID}.jsonl`);
    writeFileSync(
        path,
        lines({ type: "user", sessionId: ID, cwd: "/projects/shop", message: { content: "first prompt" } })
    );
    const source = (await claudeHistoryReader.discover([root])).sources[0]!;
    const scan = claudeHistoryReader.scan!;
    let changed = false;
    const changingReader: NativeSessionReader<"claude"> = {
        ...claudeHistoryReader,
        async *scan(candidate, options) {
            for await (const record of scan(candidate, options)) {
                yield record;
                if (!changed) {
                    appendFileSync(
                        path,
                        lines({
                            type: "assistant",
                            sessionId: ID,
                            message: { content: "arrived during hydration" },
                        })
                    );
                    changed = true;
                }
            }
        },
    };

    await expect(readCompatibilityTranscript(changingReader, source)).rejects.toThrow(
        "Source changed during compatibility read"
    );
});

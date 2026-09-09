import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { discoverClaudeHistorySources } from "./readers/claude-discovery";
import { discoverCodexHistorySources } from "./readers/codex-discovery";
import { discoverGrokHistorySources } from "./readers/grok-discovery";
import { walkSourceRoots } from "./source-discovery";

const ID_A = "11111111-2222-4333-8444-555555555555";
const ID_B = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function line(value: object): string {
    return `${SafeJSON.stringify(value, { strict: true })}\n`;
}

test("canonical walker deduplicates aliases and withholds incomplete roots", async () => {
    const directory = mkdtempSync(join(tmpdir(), "gt-discovery-walk-"));
    const good = join(directory, "good");
    const nested = join(good, "nested");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "one.jsonl"), "{}\n");
    symlinkSync(good, join(nested, "loop"));
    const alias = join(directory, "alias");
    symlinkSync(good, alias);

    const complete = await walkSourceRoots({
        roots: [good, alias],
        includeFile: ({ path }) => path.endsWith(".jsonl"),
    });

    expect(complete.files.map((file) => file.path)).toEqual([realpathSync(join(nested, "one.jsonl"))]);
    expect(complete.completeRoots).toEqual([realpathSync(good)]);
    expect(complete.issues).toEqual([]);

    const failed = join(directory, "failed");
    mkdirSync(failed);
    symlinkSync(join(directory, "missing-target"), join(failed, "broken"));
    const missingRoot = join(directory, "missing-root");
    const incomplete = await walkSourceRoots({ roots: [failed, missingRoot] });

    expect(incomplete.completeRoots).toEqual([]);
    expect(incomplete.issues.map((issue) => issue.message)).toEqual([
        "Source entry read failed",
        "Source root unavailable",
    ]);
});

test("Claude discovery keeps shallow mains and per-session sidecar revisions", async () => {
    const home = mkdtempSync(join(tmpdir(), "gt-discovery-claude-"));
    const root = join(home, "projects");
    const shopProject = "-projects-shop";
    const shop = join(root, shopProject);
    const other = join(root, "-projects-other");
    mkdirSync(shop, { recursive: true });
    mkdirSync(other, { recursive: true });
    const mainA = join(shop, `${ID_A}.jsonl`);
    const mainB = join(shop, `${ID_B}.jsonl`);
    writeFileSync(mainA, line({ type: "user", sessionId: ID_A, message: { content: "A" } }));
    writeFileSync(mainB, line({ type: "user", sessionId: ID_B, message: { content: "B" } }));
    writeFileSync(join(other, "other.jsonl"), line({ type: "user", sessionId: "other" }));
    const subagents = join(shop, ID_A, "subagents");
    mkdirSync(subagents, { recursive: true });
    const agent = join(subagents, "agent-helper.jsonl");
    writeFileSync(agent, line({ type: "assistant", sessionId: ID_A, isSidechain: true }));
    const indexPath = join(shop, "sessions-index.json");
    const writeIndex = (titleB: string): void => {
        writeFileSync(
            indexPath,
            SafeJSON.stringify(
                {
                    version: 1,
                    entries: [
                        {
                            sessionId: ID_A,
                            customTitle: "Title A",
                            projectPath: "/projects/shop",
                            modified: "2026-09-01T10:00:00.000Z",
                        },
                        {
                            sessionId: ID_B,
                            customTitle: titleB,
                            projectPath: "/projects/shop",
                            modified: "2026-09-01T10:01:00.000Z",
                        },
                    ],
                },
                { strict: true }
            )
        );
    };
    writeIndex("Title B");

    const shallow = await discoverClaudeHistorySources([root], { excludeAgents: true });
    expect(shallow.sources.map((source) => basename(source.filePath)).sort()).toEqual([
        `${ID_A}.jsonl`,
        `${ID_B}.jsonl`,
        "other.jsonl",
    ]);
    expect(shallow.completeRoots).toEqual([]);

    const agents = await discoverClaudeHistorySources([root], { agentsOnly: true });
    expect(agents.sources.map((source) => basename(source.filePath))).toEqual(["agent-helper.jsonl"]);
    expect(agents.completeRoots).toEqual([]);

    const before = await discoverClaudeHistorySources([root]);
    const beforeA = before.sources.find((source) => source.filePath === realpathSync(mainA));
    const beforeB = before.sources.find((source) => source.filePath === realpathSync(mainB));
    expect(before.completeRoots).toEqual([realpathSync(root)]);
    expect(beforeA?.metadata?.title).toBe("Title A");
    expect(beforeA?.searchPaths).toEqual([realpathSync(mainA)]);
    expect(beforeB?.metadata?.title).toBe("Title B");

    writeIndex("Changed B");
    const after = await discoverClaudeHistorySources([root]);
    const afterA = after.sources.find((source) => source.filePath === realpathSync(mainA));
    const afterB = after.sources.find((source) => source.filePath === realpathSync(mainB));
    expect(afterA?.metadataFingerprint).toBe(beforeA?.metadataFingerprint);
    expect(afterB?.metadataFingerprint).not.toBe(beforeB?.metadataFingerprint);
    expect(afterB?.metadata?.title).toBe("Changed B");

    const exact = await discoverClaudeHistorySources([root], { project: shopProject });
    expect(exact.sources.every((source) => source.filePath.startsWith(realpathSync(shop)))).toBe(true);
    expect(exact.completeRoots).toEqual([]);

    const conservative = await discoverClaudeHistorySources([root], { project: "unknown-project" });
    expect(conservative.sources).toEqual([]);
    expect(conservative.completeRoots).toEqual([]);
});

test("Claude discovery excludes workflow journals and keeps the winning copy of a duplicate identity", async () => {
    const home = mkdtempSync(join(tmpdir(), "gt-discovery-claude-duplicates-"));
    const root = join(home, "projects");
    const firstProject = join(root, "-projects-first");
    const secondProject = join(root, "-projects-second");
    const sessionId = "33333333-4444-4555-8666-777777777777";
    const smaller = join(firstProject, `${sessionId}.jsonl`);
    const larger = join(secondProject, `${sessionId}.jsonl`);
    const workflow = join(firstProject, sessionId, "subagents", "workflows", "wf-fixture", "journal.jsonl");
    mkdirSync(join(workflow, ".."), { recursive: true });
    mkdirSync(secondProject, { recursive: true });
    writeFileSync(smaller, line({ type: "user", sessionId, message: { content: "short" } }));
    writeFileSync(larger, line({ type: "user", sessionId, message: { content: "longer retained source" } }));
    writeFileSync(workflow, line({ type: "workflow-event", sessionId }));

    // Real corpus: moving a checkout leaves a 194-byte stub under the old encoded project
    // directory beside the 25 MB transcript. Refusing both hid the whole conversation from
    // `tools claude history` and `resume`, so the ranked winner is indexed and the copy it
    // displaced is reported instead.
    const result = await discoverClaudeHistorySources([root]);
    expect(result.sources.map((source) => source.filePath)).toEqual([realpathSync(larger)]);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.path).toBe(realpathSync(smaller));
    expect(result.issues[0]?.message).toContain(realpathSync(larger));
    // Choosing a winner resolves the conflict, so the root is still fully scanned.
    expect(result.completeRoots).toEqual([realpathSync(root)]);
    expect(result.sources.some((source) => source.filePath === realpathSync(workflow))).toBe(false);
});

test("Codex discovery keys sidecars and projections by the first header id", async () => {
    const home = mkdtempSync(join(tmpdir(), "gt-discovery-codex-"));
    const root = join(home, "sessions");
    mkdirSync(root);
    const childPath = join(root, `rollout-parent-name-${ID_B}.jsonl`);
    const otherPath = join(root, `rollout-${ID_B}.jsonl`);
    writeFileSync(
        childPath,
        line({
            type: "session_meta",
            payload: {
                id: ID_A,
                session_id: ID_B,
                cwd: "/projects/child",
                history_mode: "paginated",
                git: { branch: "child-branch" },
            },
        }) +
            line({
                type: "session_meta",
                payload: {
                    id: ID_B,
                    cwd: "/projects/parent",
                    history_mode: "legacy",
                },
            })
    );
    writeFileSync(
        otherPath,
        line({
            type: "session_meta",
            payload: { id: ID_B, cwd: "/projects/other", history_mode: "legacy" },
        })
    );
    const statePath = join(home, "state_5.sqlite");
    const state = new Database(statePath);
    state.run("PRAGMA journal_mode = WAL");
    state.run("CREATE TABLE threads (id TEXT, title TEXT, cwd TEXT, updated_at INTEGER, archived INTEGER)");
    state.run("INSERT INTO threads VALUES (?, ?, ?, ?, ?)", [
        ID_A,
        "Child state title",
        "/projects/child-state",
        1_788_257_400,
        0,
    ]);
    state.run("INSERT INTO threads VALUES (?, ?, ?, ?, ?)", [
        ID_B,
        "Other state title",
        "/projects/other-state",
        1_788_257_401,
        0,
    ]);
    const projectionPath = join(home, "thread_history_1.sqlite");
    const projection = new Database(projectionPath);
    projection.run("PRAGMA journal_mode = WAL");
    projection.run(
        "CREATE TABLE thread_items (thread_id TEXT, rollout_ordinal INTEGER, created_at_ms INTEGER, item_json TEXT, updated_at_ordinal INTEGER)"
    );
    projection.run("INSERT INTO thread_items VALUES (?, 1, 1788257400000, ?, 1)", [
        ID_A,
        SafeJSON.stringify({ type: "agentMessage", text: "child" }, { strict: true }),
    ]);
    projection.run("INSERT INTO thread_items VALUES (?, 1, 1788257400000, ?, 1)", [
        ID_B,
        SafeJSON.stringify({ type: "agentMessage", text: "other" }, { strict: true }),
    ]);
    const sessionIndex = join(home, "session_index.jsonl");
    writeFileSync(
        sessionIndex,
        line({ id: ID_A, thread_name: "Child index title", updated_at: "2026-09-01T10:00:00.000Z" }) +
            line({ id: ID_B, thread_name: "Other index title", updated_at: "2026-09-01T10:00:00.000Z" })
    );

    const before = await discoverCodexHistorySources([root]);
    const childBefore = before.sources.find((source) => source.filePath === realpathSync(childPath));
    const otherBefore = before.sources.find((source) => source.filePath === realpathSync(otherPath));
    expect(before.completeRoots).toEqual([realpathSync(root)]);
    expect(childBefore?.searchPaths).toBeUndefined();
    expect(otherBefore?.searchPaths).toEqual([realpathSync(otherPath)]);
    expect(childBefore?.metadata).toMatchObject({
        sessionId: ID_A,
        title: "Child state title",
        cwd: "/projects/child",
        gitBranch: "child-branch",
    });
    expect(childBefore?.metadataPaths.some((path) => path.endsWith("thread_history_1.sqlite-wal"))).toBe(true);

    projection.run("UPDATE thread_items SET item_json = ?, updated_at_ordinal = 2 WHERE thread_id = ?", [
        SafeJSON.stringify({ type: "agentMessage", text: "changed other" }, { strict: true }),
        ID_B,
    ]);
    const afterOther = await discoverCodexHistorySources([root]);
    const childAfterOther = afterOther.sources.find((source) => source.filePath === realpathSync(childPath));
    expect(childAfterOther?.metadataFingerprint).toBe(childBefore?.metadataFingerprint);

    projection.run("UPDATE thread_items SET item_json = ?, updated_at_ordinal = 2 WHERE thread_id = ?", [
        SafeJSON.stringify({ type: "agentMessage", text: "changed child" }, { strict: true }),
        ID_A,
    ]);
    const afterChild = await discoverCodexHistorySources([root]);
    const childAfterChild = afterChild.sources.find((source) => source.filePath === realpathSync(childPath));
    expect(childAfterChild?.metadataFingerprint).not.toBe(childBefore?.metadataFingerprint);

    projection.close();
    state.close();
});

test("Grok discovery is chat-first and excludes usage telemetry", async () => {
    const home = mkdtempSync(join(tmpdir(), "gt-discovery-grok-"));
    const root = join(home, "sessions");
    const summaryless = join(root, encodeURIComponent("/projects/shop"), ID_A);
    const summarized = join(root, encodeURIComponent("/projects/other"), ID_B);
    mkdirSync(summaryless, { recursive: true });
    mkdirSync(summarized, { recursive: true });
    const snake = join(summaryless, "chat_history.jsonl");
    const camel = join(summaryless, "chatHistory.jsonl");
    writeFileSync(snake, line({ type: "user", content: "snake" }));
    writeFileSync(camel, line({ type: "user", content: "camel" }));
    writeFileSync(join(summaryless, "updates.jsonl"), line({ type: "user", content: "usage only" }));
    const summarizedChat = join(summarized, "chatHistory.jsonl");
    writeFileSync(summarizedChat, line({ type: "user", content: "summarized" }));
    const summaryPath = join(summarized, "summary.json");
    writeFileSync(
        summaryPath,
        SafeJSON.stringify(
            {
                info: { id: ID_B, cwd: "/projects/other" },
                generated_title: "Other title",
                session_summary: "Other summary",
            },
            { strict: true }
        )
    );

    const result = await discoverGrokHistorySources([root]);

    expect(result.completeRoots).toEqual([realpathSync(root)]);
    expect(result.issues).toEqual([]);
    expect(result.sources).toHaveLength(2);
    const first = result.sources.find((source) => source.filePath === realpathSync(snake));
    expect(first).toMatchObject({
        kind: "grok",
        sourceHome: realpathSync(home),
        dataPaths: [realpathSync(snake)],
        metadataPaths: [],
        searchPaths: [realpathSync(snake)],
    });
    expect(result.sources.some((source) => source.filePath === realpathSync(camel))).toBe(false);
    expect(result.sources.some((source) => source.filePath.endsWith("updates.jsonl"))).toBe(false);
    const second = result.sources.find((source) => source.filePath === realpathSync(summarizedChat));
    expect(second?.metadata).toMatchObject({
        sessionId: ID_B,
        cwd: "/projects/other",
        title: "Other title",
        summary: "Other summary",
    });
    expect(second?.metadataPaths).toEqual([realpathSync(summaryPath)]);
});

test("discovery accepts a pre-session_meta Codex rollout and keeps its root complete", async () => {
    // Discovery carried its own header parser that only accepted `type: "session_meta"`, so four
    // 2025 rollouts here were reported as "Native session header missing" AND their root was
    // marked incomplete on every codex search — the same shape that stopped pruning and froze
    // statistics on the Claude side. One parser now serves discovery and the reader.
    const home = mkdtempSync(join(tmpdir(), "gt-codex-legacy-discovery-"));
    const root = join(home, "sessions");
    mkdirSync(root, { recursive: true });
    const path = join(root, `rollout-2025-09-19T19-16-23-${ID_A}.jsonl`);
    writeFileSync(
        path,
        line({ id: ID_A, timestamp: "2025-09-19T19:16:23.000Z", instructions: null }) +
            line({
                type: "response_item",
                payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "old" }] },
            })
    );

    const discovered = await discoverCodexHistorySources([root]);

    expect(discovered.issues).toEqual([]);
    expect(discovered.completeRoots).toEqual([realpathSync(root)]);
    expect(discovered.sources.map((source) => source.metadata?.sessionId)).toEqual([ID_A]);
});

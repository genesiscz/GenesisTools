import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleQuestionPost } from "@app/genesis-tools-mcp/lib/tools/question-post";
import { postFromCli } from "@app/question/commands/ask";
import { type Migration, runMigrations } from "@genesiscz/utils/database/migrations";
import { encodeRgbaToPng } from "@genesiscz/utils/image/raster";
import { SafeJSON } from "@genesiscz/utils/json";
import { readDecisions, updateDecisions } from "./decisions/store";
import type { AskDeps } from "./pending/ask";
import { PENDING_MIGRATIONS } from "./pending/store";
import { pollQuestions, postQuestion, type QuestionVerbDeps } from "./verbs";

type ScratchDeps = QuestionVerbDeps & {
    db: Database;
    decisionLog: { file: string; events: string; session: string };
};

const open: Database[] = [];

/**
 * A fresh pending-form store and decision log; nothing reaches the real qa store or Notification Center. `ctx`
 * names the poster for both stores, `session` is the poll's own session.
 */
function scratch({
    ctx,
    session = "sess-1",
    transclude,
}: {
    ctx?: AskDeps["ctx"];
    session?: string;
    transclude?: QuestionVerbDeps["transclude"];
} = {}): ScratchDeps {
    const db = new Database(":memory:");
    runMigrations(db, PENDING_MIGRATIONS as Migration[], { tableName: "qa_pending" });
    open.push(db);
    const dir = mkdtempSync(join(tmpdir(), "gt-question-verbs-"));

    return {
        db,
        eventBase: join(dir, "events"),
        logBase: join(dir, "log"),
        notify: false,
        ...(ctx ? { ctx } : {}),
        ...(transclude ? { transclude } : {}),
        decisionLog: {
            file: join(dir, "decisions.jsonl"),
            events: join(dir, "decision-events.jsonl"),
            session,
            ...(ctx ? { deps: { ctx } } : {}),
        },
    };
}

afterEach(() => {
    for (const db of open.splice(0)) {
        db.close();
    }
});

const decision = { type: "decision" as const, promptMarkdown: "Ship?", choices: ["y", "n"] };

describe("postQuestion", () => {
    test("a mixed batch posts the questions as one form and the decisions to the log", async () => {
        const deps = scratch();
        const result = await postQuestion(
            {
                sessionHint: "sess-1",
                projectPath: "/tmp/gt-verbs-fixture",
                source: "test",
                items: [{ promptMarkdown: "Which env?" }, decision, { type: "todo", promptMarkdown: "Rerun" }],
            },
            {},
            deps
        );

        expect(result.form?.id).toMatch(/^ask_/);
        expect(result.form?.items.map((item) => item.promptMarkdown)).toEqual(["Which env?"]);
        expect(result.posted.decisions.map((row) => row.id)).toEqual(["d_1_sess-1", "t_1_sess-1"]);
        expect(result.wait).toBeUndefined();
        expect(readDecisions(deps.decisionLog.file)).toHaveLength(2);
    });

    test("a decisions-only post makes no form, and a wait has nothing to wait on", async () => {
        const deps = scratch();
        const result = await postQuestion({ sessionHint: "sess-1", items: [decision] }, { wait: true }, deps);

        expect(result.form).toBeNull();
        expect(result.wait).toBeUndefined();
        expect(result.posted.markdown).toContain("❓ DECISION 1");
        expect(pollQuestions({}, deps)).toEqual({ kind: "pending", forms: [], answered: [] });
    });

    test("a mixed batch writes neither half when either one is invalid", async () => {
        const deps = scratch();
        const base = { sessionHint: "sess-1", projectPath: "/tmp/gt-verbs-fixture" };

        // A bad form: the decisions used to be stored first, and a retry stored them again.
        await expect(
            postQuestion(
                { ...base, items: [{ id: "q", promptMarkdown: "A?" }, { id: "q", promptMarkdown: "B?" }, decision] },
                {},
                deps
            )
        ).rejects.toThrow(/duplicate item id/);
        expect(existsSync(deps.decisionLog.file)).toBe(false);

        // A bad decision: the form is not posted either.
        await expect(
            postQuestion(
                { ...base, items: [{ promptMarkdown: "Which env?" }, { ...decision, promptMarkdown: "" }] },
                {},
                deps
            )
        ).rejects.toThrow(/invalid decision post/);
        expect(pollQuestions({}, deps)).toEqual({ kind: "pending", forms: [], answered: [] });
        expect(existsSync(deps.decisionLog.file)).toBe(false);
    });

    test("wait blocks on the form after both halves are written", async () => {
        const deps = scratch();
        const result = await postQuestion(
            { sessionHint: "sess-1", waitTimeoutMs: 20, items: [{ promptMarkdown: "Ship?" }, decision] },
            { wait: true },
            deps
        );

        expect(result.wait?.waiter).toBe("budget_exhausted");
        expect(result.wait?.form?.id).toBe(result.form?.id);
        expect(readDecisions(deps.decisionLog.file).map((row) => row.id)).toEqual(["d_1_sess-1"]);
    });
});

describe("pollQuestions", () => {
    test("forms and decisions come back together, unknown ids as null", async () => {
        const deps = scratch();
        const { form } = await postQuestion(
            { sessionHint: "sess-1", items: [{ promptMarkdown: "Which env?" }, decision] },
            {},
            deps
        );
        const formId = form?.id ?? "";

        expect(pollQuestions({ ids: [formId, "ask_nope", "d_1_sess-1", "d_9_sess-1"] }, deps)).toMatchObject({
            kind: "ids",
            forms: { [formId]: { id: formId, status: "pending" }, ask_nope: null },
            decisions: [
                { id: "d_1_sess-1", row: { id: "d_1_sess-1", state: "open" } },
                { id: "d_9_sess-1", row: null },
            ],
        });
    });

    test("no ids lists the pending forms and the session's answered decisions not yet acknowledged", async () => {
        const deps = scratch();
        await postQuestion({ sessionHint: "sess-1", items: [{ promptMarkdown: "Which env?" }, decision] }, {}, deps);
        await updateDecisions(deps.decisionLog.file, deps.decisionLog.events, {
            updates: [{ id: "d_1_sess-1", state: "answered", option: "b" }],
        });
        const polled = pollQuestions({}, deps);

        expect(polled.kind).toBe("pending");
        expect(polled.kind === "pending" && polled.forms.length).toBe(1);
        expect(polled.kind === "pending" && polled.answered.map((row) => [row.id, row.option])).toEqual([
            ["d_1_sess-1", "b"],
        ]);
        // Another session's poll does not see them.
        expect(pollQuestions({}, { ...deps, decisionLog: { ...deps.decisionLog, session: "sess-2" } })).toMatchObject({
            answered: [],
        });
    });
});

describe("both doors store the same rows", () => {
    const VOLATILE = new Set(["id", "created_at", "createdTs", "updatedTs", "receivedAt"]);

    /** Every stored row of one door, with the per-run values (form id, clocks) blanked. */
    function storedRows(deps: ScratchDeps): Record<string, unknown>[] {
        const blank = (value: unknown): unknown => {
            if (Array.isArray(value)) {
                return value.map(blank);
            }

            if (value && typeof value === "object") {
                return Object.fromEntries(
                    Object.entries(value).map(([key, inner]) => [key, VOLATILE.has(key) ? "<volatile>" : blank(inner)])
                );
            }

            return value;
        };
        const forms = (deps.db.query("SELECT * FROM qa_pending").all() as Record<string, unknown>[]).map((row) =>
            Object.fromEntries(
                Object.entries(row).map(([key, value]) => [
                    key,
                    key.endsWith("_json") && typeof value === "string" ? SafeJSON.parse(value) : value,
                ])
            )
        );
        // A decision id is numbered per log, so it stays; only its clocks differ.
        const decisions = readDecisions(deps.decisionLog.file).map((row) => ({
            store: "decision",
            ...(blank(row) as object),
            id: row.id,
        }));

        return [...forms.map((row) => ({ store: "form", ...(blank(row) as object) })), ...decisions];
    }

    test("a mixed payload with sourceMessage and attachments, posted through the CLI and the MCP door", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-question-parity-"));
        const shot = join(dir, "after.png");
        writeFileSync(shot, await encodeRgbaToPng(new Uint8ClampedArray([10, 20, 30, 255]), 1, 1));
        // An identified harness, so a kept sourceMessage reaches the stored anchor; one asset folder for both doors.
        const door = () =>
            scratch({
                ctx: { agent: "claude-code", sessionId: "sess-p" },
                session: "sess-p",
                transclude: { assetDir: join(dir, "assets") },
            });
        const cli = door();
        const mcp = door();

        const payload = {
            projectPath: dir,
            sessionHint: "sess-p",
            source: "agent-x",
            timeoutMs: 60_000,
            sourceMessage: { messageId: "msg-1", turnId: "turn-1" },
            wait: true,
            waitTimeoutMs: 10,
            items: [
                {
                    promptMarkdown: "Which env?",
                    choices: ["staging", { id: "p", label: "prod" }],
                    attachments: [{ type: "image" as const, path: shot, label: "Now" }],
                },
                {
                    type: "decision" as const,
                    title: "Cache",
                    promptMarkdown: "Keep the cache?",
                    choices: ["Keep it", "Drop it"],
                    recommended: "a",
                    attachments: [{ type: "image" as const, path: shot, label: "After" }],
                },
                { type: "todo" as const, promptMarkdown: "Rerun the bench", for: "agent" },
            ],
        };

        const viaCli = await postFromCli({ json: SafeJSON.stringify(payload), notify: false }, cli);
        await handleQuestionPost(payload, mcp);

        // The CLI used to drop wait and sourceMessage from a piped payload.
        expect(viaCli.wait).toBe(true);
        expect(viaCli.result.wait?.waiter).toBe("budget_exhausted");

        const cliRows = storedRows(cli);
        const mcpRows = storedRows(mcp);
        expect(cliRows.map((row) => row.store)).toEqual(["form", "decision", "decision"]);
        expect(mcpRows).toHaveLength(cliRows.length);

        for (const [index, row] of cliRows.entries()) {
            for (const key of new Set([...Object.keys(row), ...Object.keys(mcpRows[index] ?? {})])) {
                expect({ row: index, key, value: row[key] }).toEqual({ row: index, key, value: mcpRows[index]?.[key] });
            }
        }

        const anchors = cliRows.map((row) => row.transcriptAnchor ?? row.transcript_anchor_json);
        expect(anchors).toEqual(
            Array(3).fill(expect.objectContaining({ kind: "native", messageId: "msg-1", turnId: "turn-1" }))
        );
        expect(String(cliRows[1]?.prompt)).toContain("![After](");
        expect(SafeJSON.stringify(cliRows[0]?.items_json)).toContain("![Now](");
    });
});

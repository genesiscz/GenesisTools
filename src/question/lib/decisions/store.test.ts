import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listWidgetTasks, updateWidgetTask, widgetTask } from "@app/hub/lib/widget/tasks";
import { runAsCaller } from "@genesiscz/utils/agent/runtime";
import { SafeJSON } from "@genesiscz/utils/json";
import { withFileLock } from "@genesiscz/utils/storage/file-lock";
import { z } from "zod";
import { DeliveryUnknownError, deliverToSession, resolveDeliveryTarget } from "./deliver";
import { livePaneTargets, noPaneTargets } from "./deliver.fixtures";
import {
    decisionLine,
    decisionsMarkdown,
    deliverDecisions,
    listSessions,
    mentionedDecisions,
    parseDecisionBlocks,
    sendSessionDecisions,
    sessionAnswers,
    staleCrossings,
    stopHookVerdict,
} from "./read";
import { DECISION_STATES, decisionUpdateInputSchema, postDecisionsInputSchema } from "./schema";
import { sendAnsweredDecisions } from "./send";
import {
    type DecisionRecord,
    harvestDecisions,
    markNotified,
    moveDecisions,
    postDecisions,
    readDecisions,
    updateDecision,
    updateDecisions,
    updateTodo,
} from "./store";

/** A row another process wrote, appended while the test holds the decisions lock. */
function foreignRow(sessionId: string, number: number): DecisionRecord {
    return {
        id: `d_${number}_${sessionId}`,
        sessionId,
        number,
        prompt: "from another process",
        options: ["a"],
        state: "open",
        updatedTs: "2026-01-01T00:00:00.000Z",
    };
}

describe("decision store", () => {
    test("numbers are consecutive per session and never reused", async () => {
        const dir = mkdtempSync(join(tmpdir(), "decisions-"));
        const file = join(dir, "decisions.jsonl");
        const events = join(dir, "events.jsonl");
        const first = await postDecisions(file, events, {
            sessionId: "abc",
            decisions: [
                { prompt: "one", options: ["a", "b"] },
                { prompt: "two", options: ["a"] },
            ],
        });
        const second = await postDecisions(file, events, {
            sessionId: "abc",
            decisions: [{ prompt: "three", options: ["a"] }],
        });

        expect(first.map((row) => row.number)).toEqual([1, 2]);
        expect(second.map((row) => row.number)).toEqual([3]);
        expect(first[0]?.sessionId).toBe("abc");
    });

    test("a post allocates its number only after another writer releases the lock", async () => {
        const dir = mkdtempSync(join(tmpdir(), "decisions-"));
        const file = join(dir, "decisions.jsonl");
        const events = join(dir, "events.jsonl");
        let pending: Promise<DecisionRecord[]> | undefined;

        await withFileLock(`${file}.lock`, async () => {
            pending = postDecisions(file, events, {
                sessionId: "abc",
                decisions: [{ prompt: "mine", options: ["a"] }],
            });
            appendFileSync(file, `${SafeJSON.stringify(foreignRow("abc", 1))}\n`);
        });

        const created = await pending;
        expect(created?.map((row) => row.number)).toEqual([2]);
        expect(readDecisions(file).map((row) => row.id)).toEqual(["d_1_abc", "d_2_abc"]);
    });

    test("an update never drops a row another writer added while it waited", async () => {
        const dir = mkdtempSync(join(tmpdir(), "decisions-"));
        const file = join(dir, "decisions.jsonl");
        const events = join(dir, "events.jsonl");
        const [row] = await postDecisions(file, events, {
            sessionId: "abc",
            decisions: [{ prompt: "one", options: ["a"] }],
        });
        let pending: Promise<DecisionRecord> | undefined;

        await withFileLock(`${file}.lock`, async () => {
            pending = updateDecision(file, events, row.id, { state: "answered", answer: "a" });
            await Bun.sleep(0);
            expect(readDecisions(file).map((item) => item.state)).toEqual(["open"]);
            appendFileSync(file, `${SafeJSON.stringify(foreignRow("abc", 2))}\n`);
        });

        await pending;
        const rows = readDecisions(file);
        expect(rows.map((item) => [item.id, item.state])).toEqual([
            ["d_1_abc", "answered"],
            ["d_2_abc", "open"],
        ]);
    });

    test("a batch with one malformed decision is refused whole, before any row is written", async () => {
        const dir = mkdtempSync(join(tmpdir(), "decisions-"));
        const file = join(dir, "decisions.jsonl");
        const events = join(dir, "events.jsonl");

        await expect(
            postDecisions(file, events, { sessionId: "abc", decisions: [{ prompt: "ok", options: ["a"] }, {}] })
        ).rejects.toThrow(/invalid decision post[\s\S]*decisions\[1\]\.prompt/);
        await expect(postDecisions(file, events, { sessionId: "abc", decisions: [] })).rejects.toThrow(
            /invalid decision post/
        );
        expect(existsSync(file)).toBe(false);
        expect(existsSync(events)).toBe(false);
    });

    test("an update with an unknown state is refused before the log is read", async () => {
        const dir = mkdtempSync(join(tmpdir(), "decisions-"));
        const file = join(dir, "decisions.jsonl");
        const events = join(dir, "events.jsonl");
        const [row] = await postDecisions(file, events, {
            sessionId: "abc",
            decisions: [{ prompt: "one", options: [] }],
        });

        await expect(updateDecision(file, events, row.id, { state: "done" })).rejects.toThrow(
            /invalid decision update/
        );
        expect(readDecisions(file)[0]?.state).toBe("open");
    });

    test("a torn line is skipped, so the next post does not reuse a number", async () => {
        const dir = mkdtempSync(join(tmpdir(), "decisions-"));
        const file = join(dir, "decisions.jsonl");
        const events = join(dir, "events.jsonl");
        await postDecisions(file, events, { sessionId: "abc", decisions: [{ prompt: "one", options: ["a"] }] });
        appendFileSync(file, '{"id":"d_2_abc","sessionId":"ab');

        const [next] = await postDecisions(file, events, {
            sessionId: "abc",
            decisions: [{ prompt: "two", options: ["a"] }],
        });

        expect(next?.number).toBe(2);
        // The torn line had no newline; the new row must still land on a line of its own.
        expect(readDecisions(file).map((row) => row.id)).toEqual(["d_1_abc", "d_2_abc"]);
        expect(readDecisions(join(dir, "missing.jsonl"))).toEqual([]);
    });

    test("a row that parses but lacks a field readers rely on is skipped, and updates still work", async () => {
        const dir = mkdtempSync(join(tmpdir(), "decisions-"));
        const file = join(dir, "decisions.jsonl");
        const events = join(dir, "events.jsonl");
        const [row] = await postDecisions(file, events, {
            sessionId: "abc",
            decisions: [{ prompt: "one", options: ["a"] }],
        });
        appendFileSync(file, '{"id":"d_9_abc","sessionId":"abc","number":9}\n');
        appendFileSync(
            file,
            '{"id":"d_8_abc","sessionId":"abc","number":8,"prompt":"p","options":[],"state":"lost"}\n'
        );

        expect(readDecisions(file).map((item) => item.id)).toEqual([row.id]);
        expect(listSessions(readDecisions(file)).map((session) => session.decisions.length)).toEqual([1]);
        expect((await updateDecision(file, events, row.id, { state: "answered", answer: "a" })).state).toBe("answered");
    });

    test("answers are decisions with an answer; a draft without one is not an answer", async () => {
        const dir = mkdtempSync(join(tmpdir(), "decisions-"));
        const file = join(dir, "decisions.jsonl");
        const events = join(dir, "events.jsonl");
        const [drafted, answered] = await postDecisions(file, events, {
            sessionId: "abc",
            decisions: [
                { prompt: "one", options: ["a"] },
                { prompt: "two", options: ["a"] },
            ],
        });
        await updateDecision(file, events, drafted.id, { state: "drafted", draft: "maybe a" });
        await updateDecision(file, events, answered.id, { state: "answered", answer: "a" });

        expect(sessionAnswers(readDecisions(file), "abc").map((row) => row.id)).toEqual([answered.id]);
    });

    test("a send marks the whole batch sent in one transition before it emits, and never twice", async () => {
        const dir = mkdtempSync(join(tmpdir(), "decisions-"));
        const file = join(dir, "decisions.jsonl");
        const events = join(dir, "events.jsonl");
        const rows = await postDecisions(file, events, {
            sessionId: "abc",
            decisions: [
                { prompt: "one", options: ["a"] },
                { prompt: "two", options: ["b"] },
            ],
        });

        for (const [row, answer] of [
            [rows[0], "a"],
            [rows[1], "b"],
        ] as const) {
            await updateDecision(file, events, row.id, { state: "answered", answer });
        }

        const seenStates: string[][] = [];
        const sent = await sendSessionDecisions({
            file,
            events,
            session: "abc",
            emit: () => seenStates.push(readDecisions(file).map((row) => row.state)),
        });

        expect(sent.numbers).toEqual([1, 2]);
        expect(seenStates).toEqual([["sent", "sent"]]);
        await expect(sendSessionDecisions({ file, events, session: "abc", emit: () => undefined })).rejects.toThrow(
            /nothing to send/
        );
    });

    test("answered needs an answer on the merged row", async () => {
        const dir = mkdtempSync(join(tmpdir(), "decisions-"));
        const file = join(dir, "decisions.jsonl");
        const events = join(dir, "events.jsonl");
        const [bare, drafted] = await postDecisions(file, events, {
            sessionId: "abc",
            decisions: [
                { prompt: "one", options: ["a"] },
                { prompt: "two", options: ["b"] },
            ],
        });

        await expect(updateDecision(file, events, bare.id, { state: "answered" })).rejects.toThrow(/without an answer/);
        await updateDecision(file, events, drafted.id, { answer: "b" });
        const answered = await updateDecision(file, events, drafted.id, { state: "answered" });
        expect(answered).toMatchObject({ state: "answered", answer: "b" });
    });

    test("a send whose delivery fails puts the answers back for the next send", async () => {
        const dir = mkdtempSync(join(tmpdir(), "decisions-"));
        const file = join(dir, "decisions.jsonl");
        const events = join(dir, "events.jsonl");
        const [row] = await postDecisions(file, events, {
            sessionId: "abc",
            decisions: [{ prompt: "one", options: ["a"] }],
        });
        await updateDecision(file, events, row.id, { state: "answered", answer: "a" });

        await expect(
            sendSessionDecisions({
                file,
                events,
                session: "abc",
                emit: () => {
                    throw new Error("pane gone");
                },
            })
        ).rejects.toThrow(/pane gone/);
        expect(readDecisions(file)[0]?.state).toBe("answered");

        const again = await sendSessionDecisions({ file, events, session: "abc", emit: () => undefined });
        expect(again.text).toBe("DECISION 1: a");
    });

    test("a relative ref is read from the decision's cwd, not this process's", async () => {
        const dir = mkdtempSync(join(tmpdir(), "decisions-"));
        writeFileSync(join(dir, "note.txt"), ["one", "two", "three"].join("\n"));
        const file = join(dir, "decisions.jsonl");
        const events = join(dir, "events.jsonl");
        const [row] = await postDecisions(file, events, {
            sessionId: "abc",
            cwd: dir,
            decisions: [{ prompt: "keep two?", options: ["yes"], refs: [{ path: "note.txt", line: 2, endLine: 2 }] }],
        });

        expect(row?.excerpt).toBe("two");
    });

    test("a lost event never fails a decision that was saved", async () => {
        const dir = mkdtempSync(join(tmpdir(), "decisions-"));
        const file = join(dir, "decisions.jsonl");
        // A directory where the events file should be: every event append fails.
        const events = mkdtempSync(join(tmpdir(), "decision-events-"));

        const [row] = await postDecisions(file, events, {
            sessionId: "abc",
            decisions: [{ prompt: "one", options: ["a"] }],
        });
        const answered = await updateDecision(file, events, row.id, { state: "answered", answer: "a" });

        expect(answered.state).toBe("answered");
        expect(readDecisions(file).map((item) => [item.id, item.state])).toEqual([[row.id, "answered"]]);
    });

    test("a batch move with one invalid row changes nothing", async () => {
        const dir = mkdtempSync(join(tmpdir(), "decisions-"));
        const file = join(dir, "decisions.jsonl");
        const events = join(dir, "events.jsonl");
        const [answered, open] = await postDecisions(file, events, {
            sessionId: "abc",
            decisions: [
                { prompt: "one", options: ["a"] },
                { prompt: "two", options: ["b"] },
            ],
        });
        await updateDecision(file, events, answered.id, { state: "answered", answer: "a" });

        await expect(moveDecisions(file, events, [answered.id, open.id], "sent")).rejects.toThrow(/cannot move/);
        expect(readDecisions(file).map((row) => row.state)).toEqual(["answered", "open"]);
    });

    test("the published MCP schemas carry the required fields and the state list", () => {
        const post = z.toJSONSchema(postDecisionsInputSchema, { io: "input" }) as { required?: string[] };
        const update = z.toJSONSchema(decisionUpdateInputSchema, { io: "input" }) as {
            required?: string[];
            properties?: { state?: { enum?: string[] } };
        };

        expect(post.required).toEqual(["decisions"]);
        expect(update.required).toEqual(["id"]);
        expect(update.properties?.state?.enum).toEqual([...DECISION_STATES]);
    });

    test("invalid transitions are refused", async () => {
        const dir = mkdtempSync(join(tmpdir(), "decisions-"));
        const file = join(dir, "decisions.jsonl");
        const events = join(dir, "events.jsonl");
        const [row] = await postDecisions(file, events, {
            sessionId: "abc",
            decisions: [{ prompt: "one", options: ["a"] }],
        });

        await expect(updateDecision(file, events, row.id, { state: "implemented" })).rejects.toThrow(/cannot move/);
        const answered = await updateDecision(file, events, row.id, { state: "answered", answer: "a" });
        expect(answered.state).toBe("answered");
        expect(readFileSync(events, "utf8")).toContain('"ev":"created"');
        expect(readFileSync(events, "utf8")).toContain('"ev":"updated"');
    });

    test("a letter past the options is refused by every update door, before anything is written", async () => {
        const dir = mkdtempSync(join(tmpdir(), "decisions-"));
        const file = join(dir, "decisions.jsonl");
        const events = join(dir, "events.jsonl");
        const [row] = await postDecisions(file, events, {
            sessionId: "abc",
            decisions: [{ prompt: "cache?", options: ["keep", "drop", "both"] }],
        });

        // `tools question answer d_1_abc --option z` and question_update both land here.
        await expect(
            updateDecisions(file, events, { updates: [{ id: row.id, state: "answered", option: "z" }] })
        ).rejects.toThrow('DECISION 1 has options a-c, not "z"');
        expect(readDecisions(file)[0]).toMatchObject({ state: "open" });

        const answered = await updateDecision(file, events, row.id, { state: "answered", option: "c" });
        expect(decisionLine(answered)).toBe("DECISION 1: c) both");
    });

    test("a draft can be saved again before it is sent", async () => {
        const dir = mkdtempSync(join(tmpdir(), "decisions-"));
        const file = join(dir, "decisions.jsonl");
        const events = join(dir, "events.jsonl");
        const [row] = await postDecisions(file, events, {
            sessionId: "abc",
            decisions: [{ prompt: "cache?", options: ["keep", "drop"] }],
        });

        // `tools question draft <id> --text`, twice: the user edits the draft.
        await updateDecision(file, events, row.id, { state: "drafted", draft: "first" });
        const again = await updateDecision(file, events, row.id, { state: "drafted", draft: "second" });

        expect(again).toMatchObject({ state: "drafted", draft: "second" });
    });

    test("an omitted session is the harness that posted it", async () => {
        const dir = mkdtempSync(join(tmpdir(), "decisions-"));
        const file = join(dir, "decisions.jsonl");
        const events = join(dir, "events.jsonl");
        const [row] = await postDecisions(
            file,
            events,
            { decisions: [{ prompt: "keep it?", options: ["yes"] }] },
            { env: { CLAUDE_CODE_SESSION_ID: "sess-9", CLAUDECODE: "1", CMUX_SURFACE_ID: "surface-7" } }
        );

        expect(row?.sessionId).toBe("sess-9");
        // The name the inbox, the hub and the delivery compare against, not the host kind "claude-code".
        expect(row?.provider).toBe("claude");
        expect(row?.cmuxSurface).toBe("surface-7");
        expect(row?.cwd?.length).toBeGreaterThan(0);
        expect(row?.project?.length).toBeGreaterThan(0);
        expect(row?.repoRoot?.length).toBeGreaterThan(0);
    });

    test("an excerpt is copied from the file the decision points at", async () => {
        const dir = mkdtempSync(join(tmpdir(), "decisions-"));
        const source = join(dir, "note.txt");
        writeFileSync(source, ["one", "two", "three"].join("\n"));
        const file = join(dir, "decisions.jsonl");
        const events = join(dir, "events.jsonl");
        const [row] = await postDecisions(file, events, {
            sessionId: "abc",
            provider: "claude",
            cwd: dir,
            decisions: [{ prompt: "keep two?", options: ["yes"], refs: [{ path: source, line: 2, endLine: 2 }] }],
        });

        expect(row?.excerpt).toBe("two");
        const [session] = listSessions([row], { now: Date.parse(row.updatedTs) + 1000 });
        expect(session?.waiting).toBe(1);
        expect(session?.provider).toBe("claude");
        expect(session?.decisions[0]?.status).toBe("waiting");
    });

    test("send refuses before the sender when nothing is due", () => {
        const send = () => {
            throw new Error("sent");
        };

        expect(() => deliverDecisions([], send)).toThrow(/nothing to send/);
    });

    test("the stop hook is off, warns, or blocks, and a reply with no marker is allowed", () => {
        expect(stopHookVerdict({ stopHook: "off", maxBlocksPerSession: 1 }, "❓ DECISION 1", [])).toEqual({
            action: "off",
        });
        expect(stopHookVerdict({ stopHook: "block", maxBlocksPerSession: 1 }, "no marker", [])).toEqual({
            action: "allow",
        });
        expect(stopHookVerdict({ stopHook: "warn", maxBlocksPerSession: 1 }, "❓ DECISION 2", [1]).action).toBe("warn");
        expect(
            stopHookVerdict({ stopHook: "block", maxBlocksPerSession: 1, blocksUsed: 1 }, "❓ DECISION 2", []).action
        ).toBe("warn");
        expect(stopHookVerdict({ stopHook: "block", maxBlocksPerSession: 1 }, "❓ DECISION 2", []).action).toBe(
            "block"
        );
    });
});

function scratch(): { file: string; events: string; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), "decisions-"));
    return { dir, file: join(dir, "decisions.jsonl"), events: join(dir, "events.jsonl") };
}

describe("decision kinds, batch updates, harvest and staleness", () => {
    test("a todo has its own numbers and a t_ id, and is done rather than answered", async () => {
        const { file, events } = scratch();
        const rows = await postDecisions(file, events, {
            sessionId: "abc",
            decisions: [
                { prompt: "pick one", options: ["a", "b"] },
                { type: "todo", prompt: "rerun the bench", for: "agent", reevaluateWhen: "after the PR merges" },
                { prompt: "pick again", options: ["a"] },
            ],
        });

        expect(rows.map((row) => row.id)).toEqual(["d_1_abc", "t_1_abc", "d_2_abc"]);
        expect(rows[1]).toMatchObject({
            type: "todo",
            options: [],
            for: "agent",
            reevaluateWhen: "after the PR merges",
        });
        await expect(updateDecision(file, events, "t_1_abc", { state: "answered", answer: "x" })).rejects.toThrow(
            /cannot move t_1_abc from open to answered/
        );
        expect((await updateDecision(file, events, "t_1_abc", { state: "implemented" })).state).toBe("implemented");
    });

    test("a batch update is one change: one bad id or move leaves every row as it was", async () => {
        const { file, events } = scratch();
        await postDecisions(file, events, {
            sessionId: "abc",
            decisions: [
                { prompt: "one", options: ["keep", "drop"] },
                { prompt: "two", options: ["a"] },
            ],
        });

        await expect(
            updateDecisions(file, events, {
                updates: [
                    { id: "d_1_abc", state: "answered", option: "b" },
                    { id: "d_2_abc", state: "implemented" },
                ],
            })
        ).rejects.toThrow(/cannot move d_2_abc/);
        expect(readDecisions(file).map((row) => row.state)).toEqual(["open", "open"]);

        const updated = await updateDecisions(file, events, {
            updates: [
                { id: "d_1_abc", state: "answered", option: "b" },
                { id: "d_2_abc", comment: "first look" },
                { id: "d_2_abc", comment: "second look", verdict: "deferred" },
            ],
        });

        expect(updated.map((row) => row.id)).toEqual(["d_1_abc", "d_2_abc"]);
        expect(updated[1]).toMatchObject({ comments: ["first look", "second look"], verdict: "deferred" });
        // A bare option is an answer: the line carries the option's own label.
        expect(decisionLine(updated[0] as DecisionRecord)).toBe("DECISION 1: b) drop");
    });

    test("the delivered text is built from the stored option and answer only", () => {
        const row = { ...foreignRow("abc", 4), options: ["keep", "drop"], option: "a", answer: "keep, and log it" };

        expect(decisionLine(row)).toBe("DECISION 4: a) keep, and log it");
        expect(decisionLine({ ...row, option: undefined })).toBe("DECISION 4: keep, and log it");
    });

    test("a titled card retains its chat label separately from its allocated ledger number", () => {
        const row = {
            ...foreignRow("original-session", 2),
            title: "Chat DECISION 4: next token kinds",
            answer: '<fromImage>\n{\n  "path": "/fixture/c96d5e67-image.png"\n}\n</fromImage>',
        };
        expect(decisionLine(row)).toBe(
            'Reply to: Chat DECISION 4: next token kinds\nLedger decision 2 (d_2_original-session)\n<fromImage>\n{\n  "path": "/fixture/c96d5e67-image.png"\n}\n</fromImage>'
        );
        expect(row.sessionId).toBe("original-session");
        expect(row.number).toBe(2);
    });

    test("the markdown numbers todos apart and marks the recommended option", async () => {
        const { file, events } = scratch();
        const rows = await postDecisions(file, events, {
            sessionId: "abc",
            decisions: [
                { title: "Cache", prompt: "Keep it?", options: ["yes", "no"], recommended: "b", blocking: true },
                { type: "todo", title: "Bench", prompt: "Rerun it", for: "agent" },
            ],
        });
        const markdown = decisionsMarkdown(rows);

        expect(markdown).toContain("### ❓ DECISION 1 — Cache");
        expect(markdown).toContain("b) no (recommended)");
        expect(markdown).toContain("### ☐ TODO 1 — Bench");
        expect(markdown).toContain("for: agent");
    });

    test("a reply's unposted DECISION blocks are parsed with their number, title and options", () => {
        const reply = [
            "Done with the port.",
            "",
            "❓ DECISION 7 — Keep the old flag",
            "Should `--legacy` stay for one release?",
            "- **a)** keep it with a warning",
            "- **b)** drop it now",
            "",
            "### ❓ DECISION 8",
            "Rename the file?",
            "a) yes",
            "b) no",
        ].join("\n");

        expect(parseDecisionBlocks(reply)).toMatchObject([
            {
                number: 7,
                title: "Keep the old flag",
                prompt: "Should `--legacy` stay for one release?",
                options: ["keep it with a warning", "drop it now"],
                context: "Done with the port.",
            },
            { number: 8, prompt: "Rename the file?", options: ["yes", "no"] },
        ]);
        expect(parseDecisionBlocks("no marker here")).toEqual([]);
        expect(mentionedDecisions(reply)).toEqual([7, 8]);
    });

    test("a harvest stores unposted blocks under their own number and never overwrites a posted one", async () => {
        const { file, events } = scratch();
        await postDecisions(file, events, { sessionId: "abc", decisions: [{ prompt: "posted", options: ["a"] }] });

        const stored = await harvestDecisions(file, events, {
            sessionId: "abc",
            found: [
                { number: 1, prompt: "clash", options: [] },
                { number: 5, prompt: "unposted", options: ["x"] },
            ],
        });

        expect(stored.map((row) => [row.id, row.harvested])).toEqual([["d_5_abc", true]]);
        expect(readDecisions(file).find((row) => row.number === 1)?.prompt).toBe("posted");
        expect(readFileSync(events, "utf8")).toContain('"ev":"harvested"');
    });

    test("a blocking decision crosses each staleness threshold once, and only the highest is reported", async () => {
        const { file, events } = scratch();
        const created = "2026-01-01T10:00:00.000Z";
        const rows = await postDecisions(
            file,
            events,
            {
                sessionId: "abc",
                decisions: [
                    { prompt: "blocking", options: ["a"], blocking: true },
                    { prompt: "not blocking", options: ["a"] },
                ],
            },
            { now: () => created }
        );
        const config = { warnAfterMinutes: 30, alarmAfterMinutes: 120 };
        const at = (minutes: number) => Date.parse(created) + minutes * 60_000;

        expect(staleCrossings(rows, config, at(10))).toEqual([]);
        expect(staleCrossings(rows, config, at(45)).map((item) => [item.id, item.threshold])).toEqual([
            ["d_1_abc", "warn"],
        ]);
        expect(staleCrossings(rows, config, at(200)).map((item) => item.threshold)).toEqual(["alarm"]);

        await markNotified(file, events, [{ id: "d_1_abc", threshold: "warn" }]);
        const marked = readDecisions(file);

        expect(staleCrossings(marked, config, at(45))).toEqual([]);
        expect(staleCrossings(marked, config, at(200)).map((item) => item.threshold)).toEqual(["alarm"]);
    });

    test("a stop-hook reason tells the agent to post through question_post", () => {
        const verdict = stopHookVerdict({ stopHook: "block", maxBlocksPerSession: 2 }, "❓ DECISION 3 — x", [1]);

        expect(verdict).toMatchObject({ action: "block", missing: [3] });
        expect(verdict.reason).toContain("question_post");
    });
});

describe("delivery routes", () => {
    function spy(result: { success: boolean; stdout: string; stderr?: string }) {
        const calls: string[][] = [];
        const prompts: string[] = [];
        const runTool = async (args: string[]) => {
            calls.push(args);
            if (args.includes("--prompt-file")) {
                prompts.push(readFileSync(args[args.indexOf("--prompt-file") + 1], "utf8"));
            }
            return { stderr: "", ...result };
        };
        return { calls, prompts, runTool };
    }

    test("owned Claude and Grok workers resume without cmux and require exact completed-turn receipts", async () => {
        for (const provider of ["claude", "grok"] as const) {
            const calls: string[][] = [];
            let promptFile = "";
            const result = await deliverToSession(
                {
                    session: "fixture-session",
                    provider,
                    sourceHome: "/fixture/source",
                    text: "Synthetic answer\\nwith media references",
                },
                {
                    nativeWorkers: () => [
                        {
                            provider,
                            name: "fixture",
                            sessionId: "fixture-session",
                            sourceHome: "/fixture/source",
                            turns: 1,
                            ready: true,
                        },
                    ],
                    findTargets: async () => {
                        throw new Error("native route must not require cmux");
                    },
                    runTool: async (args) => {
                        calls.push(args);
                        promptFile = args[args.indexOf("--prompt-file") + 1];
                        expect(readFileSync(promptFile, "utf8")).toBe("Synthetic answer\\nwith media references");
                        return {
                            success: true,
                            stderr: "",
                            stdout: SafeJSON.stringify({
                                kind: "turn",
                                backend: provider,
                                name: "fixture",
                                sessionId: "fixture-session",
                                sourceHome: "/fixture/source",
                                turn: 2,
                                completed: true,
                                exitCode: 0,
                            }),
                        };
                    },
                }
            );
            expect(result).toEqual({
                channel: "resume",
                delivered: true,
                target: `${provider} worker fixture · resumed turn 2`,
            });
            expect(calls[0].slice(0, provider === "claude" ? 3 : 2)).toEqual(
                provider === "claude" ? ["claude", "worker", "steer"] : ["grok", "steer"]
            );
            expect(calls[0]).toContain("--expect-session");
            expect(calls[0]).not.toContain("Synthetic answer\\nwith media references");
            expect(existsSync(promptFile)).toBe(false);
        }
    });

    test("native route rejects wrong provider, source home, worker-name aliases, busy and unstarted sessions", async () => {
        const worker = {
            provider: "grok" as const,
            name: "fixture",
            sessionId: "fixture-session",
            sourceHome: "/fixture/source",
            turns: 1,
            ready: true,
        };
        const lookup = { nativeWorkers: () => [worker], findTargets: noPaneTargets };
        for (const target of [
            { provider: "claude", session: "fixture-session", sourceHome: "/fixture/source" },
            { provider: "grok", session: "fixture-session", sourceHome: "/different/home" },
            { provider: "grok", session: "fixture", sourceHome: "/fixture/source" },
        ]) {
            expect((await resolveDeliveryTarget(target, lookup)).kind).toBe("none");
        }
        for (const reason of ["worker is busy", "session has not started"]) {
            const target = await resolveDeliveryTarget(
                { provider: "grok", session: "fixture-session", sourceHome: "/fixture/source" },
                {
                    nativeWorkers: () => [{ ...worker, ready: false, reason }],
                    findTargets: async () => {
                        throw new Error("must not reroute an owned unavailable worker");
                    },
                }
            );
            expect(target).toEqual({ kind: "none", reason });
        }
    });

    test("native delivery never accepts a lost, incomplete, wrong-session or wrong-turn receipt", async () => {
        const worker = {
            provider: "grok" as const,
            name: "fixture",
            sessionId: "fixture-session",
            sourceHome: "/fixture/source",
            turns: 1,
            ready: true,
        };
        const receipt = {
            kind: "turn",
            backend: "grok",
            name: "fixture",
            sessionId: "fixture-session",
            sourceHome: "/fixture/source",
            turn: 2,
            completed: true,
            exitCode: 0,
        };
        for (const body of [
            "not json",
            "{}",
            ...[
                { backend: "claude" },
                { sessionId: "new-copy" },
                { sourceHome: "/wrong/home" },
                { turn: 3 },
                { completed: false },
                { exitCode: 1 },
            ].map((change) => SafeJSON.stringify({ ...receipt, ...change })),
        ]) {
            let calls = 0;
            await expect(
                deliverToSession(
                    {
                        provider: "grok",
                        session: worker.sessionId,
                        sourceHome: worker.sourceHome,
                        text: "Synthetic reply",
                    },
                    {
                        nativeWorkers: () => [worker],
                        runTool: async () => {
                            calls += 1;
                            return { success: true, stdout: body, stderr: "" };
                        },
                        findTargets: async () => {
                            throw new Error("An attempted native send must not fall back and duplicate");
                        },
                    }
                )
            ).rejects.toBeInstanceOf(DeliveryUnknownError);
            expect(calls).toBe(1);
        }
        const rejected = await deliverToSession(
            { provider: "grok", session: worker.sessionId, sourceHome: worker.sourceHome, text: "Synthetic reply" },
            {
                nativeWorkers: () => [worker],
                runTool: async () => ({
                    success: false,
                    stderr: "",
                    stdout: SafeJSON.stringify({
                        kind: "rejected",
                        backend: "grok",
                        name: "fixture",
                        error: "Worker became busy before receiving input",
                    }),
                }),
            }
        );
        expect(rejected).toEqual({
            channel: "queued",
            delivered: false,
            error: "Worker became busy before receiving input",
        });
    });

    test("a Claude or Grok session gets one line typed into its cmux pane", async () => {
        const { calls, runTool } = spy({ success: true, stdout: '{"sent":true}' });
        const result = await deliverToSession(
            { session: "abc", provider: "claude-code", text: "DECISION 1: a) yes\nDECISION 2: b) no" },
            { runTool, findTargets: livePaneTargets }
        );

        expect(result).toMatchObject({ channel: "cmux", delivered: true, target: "cmux · work · agent" });
        expect(calls).toEqual([
            ["claude", "cmux", "send", "abc", "DECISION 1: a) yes\nDECISION 2: b) no", "--json", "--paste"],
        ]);
    });

    test("a closed pane is found BEFORE anything is typed: nothing runs, the reason is one sentence", async () => {
        const never = async (): Promise<never> => {
            throw new Error("must not type when no pane is live");
        };
        const result = await deliverToSession(
            { session: "abc", provider: "claude", text: "DECISION 1: a) yes" },
            { runTool: never, findTargets: noPaneTargets }
        );

        expect(result).toEqual({ channel: "queued", delivered: false, error: "no cmux pane runs this session" });
    });

    test("an unmatched pane leaves the answers queued", async () => {
        const { runTool } = spy({ success: false, stdout: '{"sent":false,"matches":[]}' });
        const result = await deliverToSession(
            { session: "abc", provider: "grok", text: "DECISION 1: yes" },
            { runTool }
        );

        expect(result.channel).toBe("queued");
        expect(result.delivered).toBe(false);
    });

    test("a readable cmux refusal reaches the durable session queue, while unreadable output does not", async () => {
        const queueRoot = mkdtempSync(join(tmpdir(), "cmux-refusal-queue-"));
        const request = {
            session: "abc",
            provider: "claude",
            text: "DECISION 1: a) yes",
            sourceHome: "/fixture/claude",
            deliveryKey: "fixture-key",
        };
        const refused = await deliverToSession(request, {
            runTool: spy({ success: false, stdout: '{"sent":false,"matches":[]}' }).runTool,
            findTargets: livePaneTargets,
            queueRoot,
        });
        expect(refused).toMatchObject({ channel: "queued", delivered: false });
        expect(refused.queueId).toBeDefined();
        const unknown = await deliverToSession(
            { ...request, deliveryKey: "other-key" },
            { runTool: spy({ success: false, stdout: "not json" }).runTool, findTargets: livePaneTargets, queueRoot }
        );
        expect(unknown).toMatchObject({ channel: "queued", delivered: false });
        expect(unknown.queueId).toBeUndefined();
    });

    test("Codex daemon queue acceptance and empty exit-zero output are not provider input receipts", async () => {
        for (const stdout of ["{}", '{"queued":true}', '{"queued":false}', ""]) {
            await expect(
                deliverToSession(
                    { session: "fixture-thread", provider: "codex", text: "Synthetic" },
                    {
                        codexWorkerFor: () => "fixture",
                        runTool: async () => ({ success: true, stdout, stderr: "" }),
                    }
                )
            ).rejects.toBeInstanceOf(DeliveryUnknownError);
        }
    });

    test("a Codex thread run by a tools codex worker is steered, and one without a worker is queued untouched", async () => {
        const steered = spy({ success: true, stdout: '{"queued":false,"turnId":"fixture-turn"}' });
        const text = ["DECISION 1: a) yes\nDECISION 2: b) no", "Synthetic media reference ".repeat(10_000)].join("\n");

        expect(
            await deliverToSession(
                { session: "thread-1", provider: "codex", text },
                { runTool: steered.runTool, codexWorkerFor: () => "reviewer" }
            )
        ).toEqual({
            channel: "codex",
            delivered: true,
            target: "codex worker reviewer · input acknowledged (turn fixture-turn)",
        });
        expect(steered.calls).toEqual([
            ["codex", "steer", "--name", "reviewer", "--json", "--prompt-file", expect.any(String)],
        ]);
        expect(steered.prompts).toEqual([text]);
        expect(existsSync(steered.calls[0][6])).toBe(false);

        const never = async (): Promise<never> => {
            throw new Error("must not run a tool when no worker exists");
        };
        const queued = await deliverToSession(
            { session: "thread-2", provider: "codex", text },
            { runTool: never, codexWorkerFor: () => null }
        );
        expect(queued.channel).toBe("queued");
    });
});

describe("superseding", () => {
    function log(): { file: string; events: string } {
        const dir = mkdtempSync(join(tmpdir(), "decisions-supersede-"));
        return { file: join(dir, "decisions.jsonl"), events: join(dir, "events.jsonl") };
    }

    test("a revision posted without a cmux surface keeps the item's delivery pane and session title", async () => {
        const { file, events } = log();
        await postDecisions(
            file,
            events,
            { sessionId: "s", title: "Fixture session", decisions: [{ prompt: "v1?", options: ["a"] }] },
            { env: { CMUX_SURFACE_ID: "surface-7" } }
        );
        const [revised] = await postDecisions(
            file,
            events,
            { sessionId: "s", decisions: [{ prompt: "v2?", options: ["a"], supersedes: "d_1_s" }] },
            { env: {} }
        );

        expect(revised).toMatchObject({ revision: 2, cmuxSurface: "surface-7", sessionTitle: "Fixture session" });
    });

    test("a drafted item goes back to open; its draft moves into the version with the old text", async () => {
        const { file, events } = log();
        await postDecisions(file, events, { sessionId: "s", decisions: [{ prompt: "v1?", options: ["a", "b"] }] });
        await updateDecision(file, events, "d_1_s", { state: "drafted", draft: "leaning b", draftOption: "b" });
        const [revised] = await postDecisions(file, events, {
            sessionId: "s",
            decisions: [{ prompt: "v2?", options: ["x"], supersedes: "d_1_s" }],
        });

        expect(revised).toMatchObject({ id: "d_1_s", number: 1, prompt: "v2?", state: "open", revision: 2 });
        expect(revised.draft).toBeUndefined();
        expect(revised.versions?.[0]).toMatchObject({
            revision: 1,
            prompt: "v1?",
            state: "drafted",
            draft: "leaning b",
            draftOption: "b",
        });
        expect(readFileSync(events, "utf8")).toContain('"ev":"superseded"');
    });

    test("a batch with one bad supersede writes nothing, not even its new items", async () => {
        const { file, events } = log();
        await postDecisions(file, events, { sessionId: "s", decisions: [{ prompt: "one?", options: [] }] });

        await expect(
            postDecisions(file, events, {
                sessionId: "s",
                decisions: [
                    { prompt: "two?", options: [] },
                    { prompt: "one again?", options: [], supersedes: "d_1_s" },
                    { prompt: "one thrice?", options: [], supersedes: "d_1_s" },
                ],
            })
        ).rejects.toThrow("cannot supersede d_1_s twice in one post");
        expect(readDecisions(file).map((row) => row.prompt)).toEqual(["one?"]);
    });

    test("another session cannot supersede an item", async () => {
        const { file, events } = log();
        await postDecisions(file, events, { sessionId: "s", decisions: [{ prompt: "mine?", options: [] }] });

        await expect(
            postDecisions(file, events, {
                sessionId: "other",
                decisions: [{ prompt: "theirs?", options: [], supersedes: "d_1_s" }],
            })
        ).rejects.toThrow("it belongs to another session");
        expect(readDecisions(file).map((row) => row.prompt)).toEqual(["mine?"]);
    });

    test("a third revision keeps both earlier versions, oldest first", async () => {
        const { file, events } = log();
        await postDecisions(file, events, { sessionId: "s", decisions: [{ type: "todo", prompt: "r1", options: [] }] });
        await postDecisions(file, events, {
            sessionId: "s",
            decisions: [{ type: "todo", prompt: "r2", options: [], supersedes: "t_1_s" }],
        });
        const [third] = await postDecisions(file, events, {
            sessionId: "s",
            decisions: [{ type: "todo", prompt: "r3", options: [], supersedes: "t_1_s" }],
        });

        expect(third.revision).toBe(3);
        expect(third.versions?.map((version) => [version.revision, version.prompt])).toEqual([
            [1, "r1"],
            [2, "r2"],
        ]);
    });
});

test("revision preconditions are checked against rows re-read under the write lock", async () => {
    const dir = mkdtempSync(join(tmpdir(), "decision-revision-"));
    const file = join(dir, "decisions.jsonl");
    const events = join(dir, "events.jsonl");
    const [row] = await postDecisions(file, events, {
        sessionId: "test-session",
        decisions: [{ prompt: "Original?", options: ["yes", "no"] }],
    });
    let pending: Promise<DecisionRecord> | undefined;
    await withFileLock(file + ".lock", async () => {
        pending = updateDecision(file, events, row.id, { state: "answered", option: "a", expectedRevision: 1 });
        pending.catch(() => undefined);
        await Bun.sleep(0);
        writeFileSync(file, SafeJSON.stringify({ ...row, prompt: "Changed?", revision: 2 }) + "\n");
    });
    await expect(pending).rejects.toThrow("stale decision revision");
    expect(readDecisions(file)[0]).toMatchObject({ prompt: "Changed?", revision: 2, state: "open" });
    const accepted = await updateDecision(file, events, row.id, {
        state: "answered",
        option: "b",
        expectedRevision: 2,
    });
    expect(accepted.option).toBe("b");
    expect(accepted).not.toHaveProperty("expectedRevision");
});

test("selected decision send leaves another answered item untouched", async () => {
    const dir = mkdtempSync(join(tmpdir(), "decision-selected-"));
    const file = join(dir, "decisions.jsonl");
    const events = join(dir, "events.jsonl");
    const rows = await postDecisions(file, events, {
        sessionId: "test-session",
        decisions: [
            { prompt: "First?", options: ["yes"] },
            { prompt: "Second?", options: ["yes"] },
        ],
    });
    await updateDecisions(file, events, {
        updates: rows.map((row) => ({ id: row.id, state: "answered", option: "a" })),
    });
    const sent = await sendSessionDecisions({
        file,
        events,
        session: "test-session",
        ids: [rows[1].id],
        emit: () => undefined,
    });
    expect(sent.numbers).toEqual([2]);
    expect(readDecisions(file).map((row) => row.state)).toEqual(["answered", "sent"]);
    const remaining = await sendSessionDecisions({ file, events, session: "test-session", emit: () => undefined });
    expect(remaining.numbers).toEqual([1]);
});

test("an unknown transport outcome is not restored to the automatic decision queue", async () => {
    const dir = mkdtempSync(join(tmpdir(), "decision-unknown-"));
    const file = join(dir, "decisions.jsonl");
    const events = join(dir, "events.jsonl");
    const [row] = await postDecisions(file, events, {
        sessionId: "test-session",
        decisions: [{ prompt: "Proceed?", options: ["yes"] }],
    });
    await updateDecision(file, events, row.id, { state: "answered", option: "a" });
    await expect(
        sendSessionDecisions({
            file,
            events,
            session: "test-session",
            emit: () => {
                throw new DeliveryUnknownError("receipt lost");
            },
        })
    ).rejects.toThrow("receipt lost");
    expect(readDecisions(file)[0].state).toBe("sent");
    await expect(
        sendSessionDecisions({ file, events, session: "test-session", emit: () => undefined })
    ).rejects.toThrow("nothing to send");
});

test("decision dry-run applies the same selected-kind filter as delivery", async () => {
    const dir = mkdtempSync(join(tmpdir(), "decision-dry-run-"));
    const file = join(dir, "decisions.jsonl");
    const events = join(dir, "events.jsonl");
    const [decision, todo] = await postDecisions(file, events, {
        sessionId: "test-session",
        decisions: [
            { prompt: "Proceed?", options: ["yes"] },
            { type: "todo", prompt: "Follow up", options: ["done"] },
        ],
    });
    // Existing files may contain legacy answered TODO rows, even though current transitions reject them.
    writeFileSync(
        file,
        `${[decision, todo].map((row) => SafeJSON.stringify({ ...row, state: "answered", option: "a" })).join("\n")}\n`
    );
    const files = { file, events };
    const preview = await sendAnsweredDecisions({ session: "test-session", files, dryRun: true });
    expect(preview.text).toBe("DECISION 1: a) yes");
    await expect(
        sendAnsweredDecisions({ session: "test-session", files, ids: [todo.id], dryRun: true })
    ).rejects.toThrow("nothing to send");
    const sent = await sendAnsweredDecisions({
        session: "test-session",
        files,
        provider: "codex",
        deps: {
            codexWorkerFor: () => "fixture-worker",
            runTool: async () => ({ success: true, stdout: '{"queued":false,"turnId":"fixture-turn"}', stderr: "" }),
        },
    });
    expect(sent.text).toBe(preview.text);
    expect(readDecisions(file).map((row) => row.state)).toEqual(["sent", "answered"]);
});

test("a lost receipt stamps only the decisions this send claimed, never one reserved by another queue", async () => {
    const dir = mkdtempSync(join(tmpdir(), "decision-claimed-"));
    const file = join(dir, "decisions.jsonl");
    const events = join(dir, "events.jsonl");
    const [reserved, open] = await postDecisions(file, events, {
        sessionId: "test-session",
        decisions: [
            { prompt: "First?", options: ["yes"] },
            { prompt: "Second?", options: ["no"] },
        ],
    });
    const reservation = { route: "queued" as const, queueId: "queue-a", at: "2026-01-01T00:00:00.000Z" };
    writeFileSync(
        file,
        `${[
            { ...reserved, state: "answered", option: "a", delivery: reservation },
            { ...open, state: "answered", option: "a" },
        ]
            .map((row) => SafeJSON.stringify(row))
            .join("\n")}\n`
    );
    await expect(
        sendAnsweredDecisions({
            session: "test-session",
            files: { file, events },
            provider: "codex",
            deps: {
                codexWorkerFor: () => "fixture-worker",
                runTool: async () => ({ success: true, stdout: "not a receipt", stderr: "" }),
            },
        })
    ).rejects.toThrow("acknowledgement");
    const [first, second] = readDecisions(file);
    expect(first.delivery).toEqual(reservation);
    expect(second.delivery?.uncertain).toBe(true);
});

test("an answer reserved by a queued delivery cannot be changed under its queue message", async () => {
    const dir = mkdtempSync(join(tmpdir(), "decision-reserved-"));
    const file = join(dir, "decisions.jsonl");
    const events = join(dir, "events.jsonl");
    const [row] = await postDecisions(file, events, {
        sessionId: "test-session",
        decisions: [{ prompt: "Reserved?", options: ["yes", "no"] }],
    });
    const reservation = { route: "queued" as const, queueId: "queue-a", at: "2026-01-01T00:00:00.000Z" };
    writeFileSync(file, `${SafeJSON.stringify({ ...row, state: "answered", option: "a", delivery: reservation })}\n`);
    for (const patch of [{ option: "b" }, { answer: "changed" }, { draft: "changed" }, { draftOption: "b" }]) {
        await expect(updateDecision(file, events, row.id, patch)).rejects.toThrow("reserved by a queued delivery");
    }
    expect(readDecisions(file)[0].option).toBe("a");
    await updateDecision(file, events, row.id, { comment: "a note is still fine" });
});

test("decision revisions preserve the source turn of each posted version", async () => {
    const dir = mkdtempSync(join(tmpdir(), "decision-provenance-"));
    const file = join(dir, "decisions.jsonl");
    const events = join(dir, "events.jsonl");
    const deps = {
        env: {},
        ctx: {
            agent: "codex" as const,
            sessionId: "source-session",
            isWorktree: true,
            worktreePath: "/fixture/worktree",
        },
    };
    const [first] = await postDecisions(
        file,
        events,
        {
            sourceMessage: { turnId: "turn-original" },
            decisions: [{ prompt: "First proposal", options: ["yes"] }],
        },
        deps
    );
    const [revised] = await postDecisions(
        file,
        events,
        {
            sourceMessage: { turnId: "turn-revised" },
            decisions: [{ prompt: "Revised proposal", options: ["yes"], supersedes: first.id }],
        },
        deps
    );
    expect(revised.transcriptAnchor).toMatchObject({
        kind: "native",
        turnId: "turn-revised",
        sessionId: "source-session",
    });
    expect(revised.versions?.[0].transcriptAnchor).toMatchObject({ kind: "native", turnId: "turn-original" });
    expect(revised.worktreePath).toBe("/fixture/worktree");
    expect(readDecisions(file)[0].transcriptAnchor).toEqual(revised.transcriptAnchor);
});

test("a revised decision retains earlier repository facts without leaking them into the new context", async () => {
    const dir = mkdtempSync(join(tmpdir(), "decision-context-versions-"));
    const file = join(dir, "decisions.jsonl");
    const events = join(dir, "events.jsonl");
    const [first] = await postDecisions(
        file,
        events,
        { decisions: [{ prompt: "First", options: [] }] },
        {
            env: {},
            ctx: {
                agent: "codex",
                sessionId: "versioned-session",
                cwd: "/fixture/old",
                repoRoot: "/fixture/project",
                branch: "feat/old",
                commitSha: "111aaaa",
                isWorktree: true,
                worktreePath: "/fixture/old",
            },
        }
    );
    const [next] = await postDecisions(
        file,
        events,
        {
            decisions: [{ prompt: "Next", options: [], supersedes: first.id }],
        },
        {
            env: {},
            ctx: {
                agent: "codex",
                sessionId: "versioned-session",
                cwd: "/fixture/new",
                repoRoot: "/fixture/project",
                branch: null,
                commitSha: null,
                isWorktree: false,
                worktreePath: null,
            },
        }
    );
    expect(next.branch).toBeUndefined();
    expect(next.commitSha).toBeUndefined();
    expect(next.cwd).toBe("/fixture/new");
    expect(next.versions?.[0]).toMatchObject({
        branch: "feat/old",
        commitSha: "111aaaa",
        cwd: "/fixture/old",
        worktreePath: "/fixture/old",
        provider: "codex",
    });
});

test("a revision posted without a harness keeps the item's provider", async () => {
    const dir = mkdtempSync(join(tmpdir(), "decision-revision-provider-"));
    const file = join(dir, "decisions.jsonl");
    const events = join(dir, "events.jsonl");
    const [first] = await postDecisions(
        file,
        events,
        { decisions: [{ type: "todo", prompt: "First", options: [] }] },
        { env: {}, ctx: { agent: "codex", sessionId: "provider-session" } }
    );
    const [next] = await postDecisions(
        file,
        events,
        {
            sessionId: "provider-session",
            decisions: [{ type: "todo", prompt: "Next", options: [], supersedes: first.id }],
        },
        { env: {}, ctx: { agent: "unknown", sessionId: null } }
    );
    expect(first.provider).toBe("codex");
    expect(next.provider).toBe("codex");
    expect(readDecisions(file)[0].provider).toBe("codex");
});

test("a decision provider override cannot inherit another provider's native message IDs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "decision-retarget-anchor-"));
    const [row] = await postDecisions(
        join(dir, "decisions.jsonl"),
        join(dir, "events.jsonl"),
        {
            provider: "codex",
            decisions: [{ prompt: "Which?", options: [] }],
        },
        {
            env: {},
            ctx: { agent: "claude-code", sessionId: "source-session", sourceMessage: { messageId: "claude-message" } },
        }
    );
    expect(row.transcriptAnchor?.kind).toBe("receipt-time");
    expect(row.transcriptAnchor).not.toHaveProperty("messageId");
});

test("an unrecognized provider override never anchors to the poster's own transcript", async () => {
    const dir = mkdtempSync(join(tmpdir(), "decision-custom-provider-"));
    const [row] = await postDecisions(
        join(dir, "decisions.jsonl"),
        join(dir, "events.jsonl"),
        { provider: "custom", decisions: [{ prompt: "Which?", options: [] }] },
        { env: {}, ctx: { agent: "codex", sessionId: "source-session" } }
    );
    expect(row.provider).toBe("custom");
    expect(row.transcriptAnchor).toEqual({ kind: "unanchored", receivedAt: expect.any(Number) });
});

test("a multiplexed decision uses the explicitly provided worktree for repository context", async () => {
    const dir = mkdtempSync(join(tmpdir(), "decision-gateway-"));
    const [row] = await runAsCaller({ agent: "codex", sessionId: null, cwd: "/" }, () =>
        postDecisions(
            join(dir, "decisions.jsonl"),
            join(dir, "events.jsonl"),
            {
                sessionId: "known-thread",
                cwd: "/fixture/agent-worktree",
                decisions: [{ prompt: "Ready?", options: [] }],
            },
            { env: {} }
        )
    );
    expect(row.cwd).toBe("/fixture/agent-worktree");
    expect(row.repoRoot).toBe("/fixture/agent-worktree");
    expect(row.project).toBe("agent-worktree");
    expect(row.transcriptAnchor).toMatchObject({ kind: "receipt-time", sessionId: "known-thread", provider: "codex" });
});

describe("Widget Tasks use the canonical TODO ledger", () => {
    function fixture() {
        const dir = mkdtempSync(join(tmpdir(), "widget-tasks-"));
        const files = { file: join(dir, "decisions.jsonl"), events: join(dir, "events.jsonl") };
        const row: DecisionRecord = {
            id: "t_1_fixture",
            sessionId: "fixture",
            provider: "codex",
            type: "todo",
            number: 1,
            prompt: "Run the local checks",
            title: "Verify changes",
            options: [],
            state: "open",
            revision: 1,
            project: "Fixture",
            cwd: "/fixture/worktree",
            branch: "feat/example",
            for: "agent",
            blocking: true,
            updatedTs: "2026-01-01T10:00:00.000Z",
        };
        writeFileSync(files.file, `${SafeJSON.stringify(row)}\n`);
        return { files, row };
    }
    const expected = (row: DecisionRecord) => ({
        revision: row.revision ?? 1,
        state: row.state,
        updatedTs: row.updatedTs,
        sessionId: row.sessionId,
        provider: row.provider ?? "unknown",
    });

    test("acknowledge, complete, reopen and dismiss append ordinary audit receipts", async () => {
        const { files, row } = fixture();
        let current = row;
        for (const state of ["acknowledged", "implemented", "open", "acknowledged", "dismissed", "open"] as const) {
            const next = await updateTodo({
                ...files,
                id: row.id,
                state,
                expected: expected(current),
                now: () => row.updatedTs,
            });
            expect(next.state).toBe(state);
            expect(Date.parse(next.updatedTs)).toBeGreaterThan(Date.parse(current.updatedTs));
            current = next;
        }
        const events = readFileSync(files.events, "utf8")
            .trim()
            .split("\n")
            .map((entry) => SafeJSON.parse(entry));
        expect(events.map((event) => event.state)).toEqual([
            "acknowledged",
            "implemented",
            "open",
            "acknowledged",
            "dismissed",
            "open",
        ]);
        expect(events.every((event) => event.ev === "updated" && event.id === row.id)).toBe(true);
        writeFileSync(files.file, `${SafeJSON.stringify({ ...current, type: "decision", state: "implemented" })}\n`);
        await expect(updateDecision(files.file, files.events, row.id, { state: "open" })).rejects.toThrow(
            "cannot move"
        );
    });

    test("stale state, updated stamp, revision and foreign source never overwrite the saved TODO", async () => {
        const { files, row } = fixture();
        const acknowledged = await updateTodo({ ...files, id: row.id, state: "acknowledged", expected: expected(row) });
        const before = readFileSync(files.file, "utf8");
        for (const guard of [
            expected(row),
            { ...expected(acknowledged), updatedTs: row.updatedTs },
            { ...expected(acknowledged), revision: 9 },
            { ...expected(acknowledged), provider: "grok" },
            { ...expected(acknowledged), sessionId: "other" },
        ]) {
            await expect(updateTodo({ ...files, id: row.id, state: "implemented", expected: guard })).rejects.toThrow();
            expect(readFileSync(files.file, "utf8")).toBe(before);
        }
    });

    test("cancellation while waiting for the canonical lock cannot reach mutation", async () => {
        const { files, row } = fixture();
        const before = readFileSync(files.file, "utf8");
        const controller = new AbortController();
        let pending: Promise<unknown> | undefined;
        await withFileLock(`${files.file}.lock`, async () => {
            pending = updateTodo({
                ...files,
                id: row.id,
                state: "implemented",
                expected: expected(row),
                signal: controller.signal,
            }).catch((error: unknown) => error);
            controller.abort();
        });
        expect(await pending).toBeInstanceOf(Error);
        expect(readFileSync(files.file, "utf8")).toBe(before);
        expect(existsSync(files.events)).toBe(false);
        const normal = await updateTodo({ ...files, id: row.id, state: "implemented", expected: expected(row) });
        expect(normal.state).toBe("implemented");
        expect(existsSync(files.events)).toBe(true);
    });

    test("listed provider aliases round-trip through the canonical source guard without blocking normal updates", async () => {
        for (const [alias, provider] of [
            ["codex-cli", "codex"],
            ["grok-cli", "grok"],
            ["claude_code", "claude"],
            ["claudecode", "claude"],
            ["claude-cli", "claude"],
            ["  ClAuDe  ", "claude"],
            ["codex", "codex"],
            ["custom", "custom"],
        ]) {
            const { files, row } = fixture();
            writeFileSync(files.file, `${SafeJSON.stringify({ ...row, provider: alias })}\n`);
            const task = listWidgetTasks({ file: files.file }).tasks[0];
            expect(task.provider).toBe(provider);
            const result = await updateWidgetTask({
                files,
                input: {
                    id: task.id,
                    action: "complete",
                    expected: {
                        revision: task.revision,
                        state: task.state,
                        updatedTs: task.updatedTs,
                        sessionId: task.sessionId,
                        provider: task.provider,
                    },
                },
            });
            expect(result.task.provider).toBe(provider);
            expect(result.receipt).toMatchObject({ state: "implemented", saved: true });
        }
    });

    test("metadata defaults, project/session/state filters, bounds and cache invalidation preserve source fields", async () => {
        const { files, row } = fixture();
        const rows = [
            row,
            { ...row, id: "t_2_fixture", state: "implemented", project: "Other", blocking: false },
            { ...row, id: "t_3_fixture", provider: "grok", state: "dismissed" },
            { ...row, id: "d_1_fixture", type: "decision" },
        ];
        writeFileSync(files.file, rows.map((entry) => SafeJSON.stringify(entry)).join("\n") + "\n");
        const active = listWidgetTasks({ file: files.file });
        expect(active.tasks.map((task) => task.id)).toEqual([row.id]);
        expect(active.tasks[0]?.sourceContext).toMatchObject({
            project: "Fixture",
            cwd: "/fixture/worktree",
            branch: "feat/example",
        });
        expect(active.tasks[0]?.owner).toBe("agent");
        expect(active.projects).toEqual(["Fixture", "Other"]);
        expect(listWidgetTasks({ file: files.file, filters: { scope: "all", limit: 1 } })).toMatchObject({
            total: 3,
            truncated: true,
        });
        expect(
            listWidgetTasks({ file: files.file, filters: { scope: "completed", projects: ["Other"] } }).tasks
        ).toHaveLength(1);
        expect(
            listWidgetTasks({ file: files.file, filters: { scope: "all", sessions: ["grok:fixture"] } }).tasks[0]?.state
        ).toBe("dismissed");
        expect(listWidgetTasks({ file: files.file, filters: { projects: ["absent"] } }).tasks).toEqual([]);
        const response = await updateWidgetTask({
            files,
            input: { id: row.id, action: "complete", expected: expected(row) },
        });
        expect(response.receipt).toMatchObject({ action: "complete", from: "open", state: "implemented", saved: true });
        expect(listWidgetTasks({ file: files.file }).tasks).toEqual([]);
        expect(widgetTask({ ...row, prompt: "x".repeat(3000) }).truncated).toBe(true);
        const missing = join(files.file, "absent");
        expect(listWidgetTasks({ file: missing }).tasks).toEqual([]);
        expect(existsSync(missing)).toBe(false);
        expect(() => listWidgetTasks({ file: files.file, filters: { limit: 999 } })).toThrow();
        const controller = new AbortController();
        controller.abort();
        expect(() => listWidgetTasks({ file: files.file, signal: controller.signal })).toThrow();
    });
});

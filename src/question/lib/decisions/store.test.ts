import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { withFileLock } from "@genesiscz/utils/storage/file-lock";
import { z } from "zod";
import { deliverToSession } from "./deliver";
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
import {
    type DecisionRecord,
    harvestDecisions,
    markNotified,
    moveDecisions,
    postDecisions,
    readDecisions,
    updateDecision,
    updateDecisions,
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
        const runTool = async (args: string[]) => {
            calls.push(args);
            return { stderr: "", ...result };
        };
        return { calls, runTool };
    }

    test("a Claude or Grok session gets one line typed into its cmux pane", async () => {
        const { calls, runTool } = spy({ success: true, stdout: '{"sent":true}' });
        const result = await deliverToSession(
            { session: "abc", provider: "claude-code", text: "DECISION 1: a) yes\nDECISION 2: b) no" },
            { runTool, findTargets: livePaneTargets }
        );

        expect(result).toMatchObject({ channel: "cmux", delivered: true, target: "cmux · work · agent" });
        expect(calls).toEqual([["claude", "cmux", "send", "abc", "DECISION 1: a) yes ; DECISION 2: b) no", "--json"]]);
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

    test("a Codex thread run by a tools codex worker is steered, and one without a worker is queued untouched", async () => {
        const steered = spy({ success: true, stdout: "{}" });
        const text = "DECISION 1: a) yes\nDECISION 2: b) no";

        expect(
            await deliverToSession(
                { session: "thread-1", provider: "codex", text },
                { runTool: steered.runTool, codexWorkerFor: () => "reviewer" }
            )
        ).toEqual({ channel: "codex", delivered: true, target: "codex worker reviewer" });
        expect(steered.calls).toEqual([["codex", "steer", "--name", "reviewer", "--prompt", text]]);

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

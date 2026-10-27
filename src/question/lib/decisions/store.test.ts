import { describe, expect, spyOn, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CodexSessionMeta, CodexSessionStore } from "@app/codex/lib/store";
import {
    createWidgetTask,
    editWidgetTask,
    LOCAL_TASK_SESSION,
    listWidgetTasks,
    updateWidgetTask,
    widgetTask,
} from "@app/hub/lib/widget/tasks";
import { runAsCaller } from "@genesiscz/utils/agent/runtime";
import { listSessionMessages } from "@genesiscz/utils/agent-sessions/message-queue";
import type { NativeHistoryEntry } from "@genesiscz/utils/agent-sessions/types";
import { withTimeout } from "@genesiscz/utils/async";
import { listClaudeSessionInventory } from "@genesiscz/utils/claude/peer-message";
import { standInSender } from "@genesiscz/utils/claude/peer-sender";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { readJsonlRows } from "@genesiscz/utils/jsonl";
import { withFileLock } from "@genesiscz/utils/storage/file-lock";
import { answerGitWithoutSpawning } from "@genesiscz/utils/test/no-git";
import { z } from "zod";
import { stagedSendText } from "../inbox/drafts";
import { setDecisionBannerRemover } from "./banners";
import { chatAnswers } from "./chat-answers";
import { backfillChatAnswers } from "./chat-reading";
import { DeliveryUnknownError, deliverToSession, resolveDeliveryTarget } from "./deliver";
import { livePaneTargets, noPaneTargets } from "./deliver.fixtures";
import { decisionPayload, validateQuestionItems } from "./items";
import {
    decisionLine,
    decisionQuestion,
    decisionsMarkdown,
    deliverDecisions,
    listSessions,
    mentionedDecisions,
    parseDecisionBlocks,
    questionNudgeVerdict,
    sendSessionDecisions,
    sessionAnswers,
    staleCrossings,
    stopHookVerdict,
} from "./read";
import { DECISION_STATES, decisionUpdateInputSchema, postDecisionsInputSchema } from "./schema";
import { sendAnsweredDecisions } from "./send";
import {
    awaitsDelivery,
    createTodo,
    type DecisionRecord,
    harvestDecisions,
    markNotified,
    moveDecisions,
    postDecisions,
    readDecisions,
    readDecisionsWithIntegrity,
    recordChatAnswers,
    repairDecisionLog,
    updateDecision,
    updateDecisions,
    updateTodo,
} from "./store";

// A decision post reads its checkout with eight `git` starts; see no-git.ts for the CI hang they caused.
const git = answerGitWithoutSpawning();

test("a decision post asks git only through the stub and starts no process", async () => {
    const dir = mkdtempSync(join(tmpdir(), "decisions-no-spawn-"));
    // Both start paths throw before a process exists, so a regression fails here instead of hanging on a lost exit.
    const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
        throw new Error("unexpected Bun.spawn in a decision post");
    });
    const answered = git.answered;
    const started = git.started.length;
    git.refuseOthers = true;

    try {
        await postDecisions(join(dir, "decisions.jsonl"), join(dir, "events.jsonl"), {
            sessionId: "abc",
            decisions: [{ prompt: "one", options: ["a"] }],
        });

        expect(git.answered).toBeGreaterThan(answered);
        expect(git.started.slice(started)).toEqual([]);
        expect(spawn).not.toHaveBeenCalled();
    } finally {
        git.refuseOthers = false;
        spawn.mockRestore();
    }
});

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
    test("the integrity read reports torn and malformed rows without changing the ordinary read", () => {
        const dir = mkdtempSync(join(tmpdir(), "decision-integrity-"));
        const file = join(dir, "decisions.jsonl");
        const row = foreignRow("fixture", 1);
        expect(readJsonlRows(file)).toEqual({ rows: [], skipped: 0, missing: true });
        expect(readDecisionsWithIntegrity(file)).toEqual({ rows: [], complete: false });
        expect(readDecisions(file)).toEqual([]);
        writeFileSync(file, "");
        expect(readJsonlRows(file)).toEqual({ rows: [], skipped: 0 });
        expect(readDecisionsWithIntegrity(file)).toEqual({ rows: [], complete: true });
        writeFileSync(file, SafeJSON.stringify(row) + "\n");
        expect(readDecisionsWithIntegrity(file)).toEqual({ rows: [row], complete: true });
        appendFileSync(file, '{"id":\n' + SafeJSON.stringify({ id: "invalid" }) + "\n");
        expect(readDecisionsWithIntegrity(file)).toEqual({ rows: [row], complete: false });
        expect(readDecisions(file)).toEqual([row]);
    });

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

    test("a post keeps the number its chat reply gave, and refuses one the session already used", async () => {
        const dir = mkdtempSync(join(tmpdir(), "decisions-"));
        const file = join(dir, "decisions.jsonl");
        const events = join(dir, "events.jsonl");
        const chat = await postDecisions(file, events, {
            sessionId: "abc",
            decisions: [{ number: 24, prompt: "close the alternative?", options: ["a", "b"] }],
        });
        const next = await postDecisions(file, events, {
            sessionId: "abc",
            decisions: [{ prompt: "next", options: ["a"] }],
        });

        expect(chat[0]?.number).toBe(24);
        expect(chat[0]?.id).toBe("d_24_abc");
        expect(next[0]?.number).toBe(25);
        await expect(
            postDecisions(file, events, {
                sessionId: "abc",
                decisions: [{ number: 24, prompt: "again", options: ["a"] }],
            })
        ).rejects.toThrow("DECISION 24 is already in session abc");
        expect(readDecisions(file)).toHaveLength(2);
    });

    test("a question_post item carries its chat number to the store, and only a decision or todo may", () => {
        const items = validateQuestionItems(
            [{ type: "decision", number: 24, promptMarkdown: "close it?", choices: ["a", "b"] }],
            "help"
        );
        const payload = postDecisionsInputSchema.parse(decisionPayload(items, { sessionId: "abc" }));

        expect(payload.decisions[0]?.number).toBe(24);
        expect(() => validateQuestionItems([{ number: 3, promptMarkdown: "a form" }], "help")).toThrow(
            "number applies to decision and todo items"
        );
        expect(() =>
            validateQuestionItems([{ type: "decision", number: 0, promptMarkdown: "x", choices: ["a"] }], "help")
        ).toThrow("number must be a positive whole number");
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

    test("a rewrite keeps the lines it cannot read, byte for byte", async () => {
        const dir = mkdtempSync(join(tmpdir(), "decisions-"));
        const file = join(dir, "decisions.jsonl");
        const events = join(dir, "events.jsonl");
        const [row] = await postDecisions(file, events, {
            sessionId: "abc",
            decisions: [{ prompt: "one", options: ["a"] }],
        });
        const wrongShape = '{"id":"d_9_abc","sessionId":"abc","number":9}';
        const torn = '{"id":"d_8_abc","sessionId":"abc","prompt":"half';
        appendFileSync(file, `${wrongShape}\n${torn}`);

        await updateDecision(file, events, row.id, { state: "answered", answer: "a" });
        const lines = readFileSync(file, "utf8").split("\n");

        expect(lines).toContain(wrongShape);
        expect(lines).toContain(torn);
        expect(readDecisions(file).map((item) => [item.id, item.state])).toEqual([[row.id, "answered"]]);
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

    test("only one prompt preparation owns a batch and a sender with an older read cannot claim it", async () => {
        const dir = mkdtempSync(join(tmpdir(), "decisions-"));
        const file = join(dir, "decisions.jsonl");
        const events = join(dir, "events.jsonl");
        const [row] = await postDecisions(file, events, {
            sessionId: "s",
            decisions: [{ prompt: "One?", options: ["yes"] }],
        });
        await updateDecision(file, events, row.id, { state: "answered", option: "a" });
        const staleIds = readDecisions(file).map((entry) => entry.id);
        const results = await Promise.allSettled([
            sendAnsweredDecisions({ session: "s", inSession: true, files: { file, events } }),
            sendAnsweredDecisions({ session: "s", inSession: true, files: { file, events } }),
        ]);
        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
        await expect(moveDecisions(file, events, staleIds, "sent")).rejects.toThrow("reserved by a submitted prompt");
        expect(readDecisions(file)[0]?.state).toBe("answered");
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

    test("a decision question needs a cue and a question in the reply's own prose", () => {
        expect(decisionQuestion("Done. One decision is yours.\nShould I keep the cache?")).toBe(
            "Should I keep the cache?"
        );
        expect(decisionQuestion("Intro?\n❓ Which store do you want: **sqlite?**")).toBe(
            "❓ Which store do you want: **sqlite?**"
        );
        expect(decisionQuestion("Choose one, see https://x.example/?a=1 for details.")).toBeNull();
        expect(decisionQuestion("Tests pass. Should I push?")).toBeNull();
        expect(decisionQuestion("I decided on sqlite. Should I push?")).toBeNull();
        expect(decisionQuestion("Done.\n```\nconst decision = ask('choose?');\n```")).toBeNull();
        expect(decisionQuestion("Done. The `decision` field stays.\nShould I push?")).toBeNull();
        expect(decisionQuestion("Martin wrote:\n> which decision do you want?\nDone.")).toBeNull();
        expect(
            decisionQuestion(
                '- Pause worked, then it asked "Discard 0:21 of recording?". Discard closed it.\nThis happened on the Decisions tab.'
            )
        ).toBeNull();
        expect(decisionQuestion('❓ DECISION 5: Should I rename "foo" to "bar"?')).toBe(
            '❓ DECISION 5: Should I rename "foo" to "bar"?'
        );
        expect(decisionQuestion(`Decide: ${"x".repeat(300)}?`)).toHaveLength(200);
    });

    test("the question nudge is off, allows a turn that logged a decision, warns, or blocks", () => {
        const question = "Should I keep the cache?";

        expect(questionNudgeVerdict({ questionNudge: "off", maxBlocksPerSession: 2 }, question, false)).toEqual({
            action: "off",
        });
        expect(questionNudgeVerdict({ questionNudge: "block", maxBlocksPerSession: 2 }, question, true)).toEqual({
            action: "allow",
        });
        expect(questionNudgeVerdict({ questionNudge: "warn", maxBlocksPerSession: 2 }, question, false).action).toBe(
            "warn"
        );
        expect(
            questionNudgeVerdict({ questionNudge: "block", maxBlocksPerSession: 2, blocksUsed: 2 }, question, false)
                .action
        ).toBe("warn");

        const block = questionNudgeVerdict({ questionNudge: "block", maxBlocksPerSession: 2 }, question, false);

        expect(block.action).toBe("block");
        expect(block.reason).toContain('("Should I keep the cache?")');
        expect(block.reason).toContain('question_post as an item of type "decision"');
        expect(block.reason).toContain("say so in one line and stop");
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

    test("an option the agent lettered itself is not lettered twice", () => {
        const row = {
            ...foreignRow("abc", 23),
            title: "Build order",
            options: ["a) run it now", "b) build the tool first, then run it for today"],
            option: "b",
        };

        expect(decisionLine(row)).toBe(
            "Reply to: Build order\nLedger decision 23 (d_23_abc)\nb) build the tool first, then run it for today"
        );
        expect(decisionLine({ ...row, options: ["(a) now", "B. later"], option: "ab" })).toContain("a) b) now / later");
        expect(decisionsMarkdown([{ ...row, option: undefined, recommended: "b" }])).toContain(
            "- a) run it now\n- b) build the tool first, then run it for today (recommended)"
        );
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
            [
                "claude",
                "cmux",
                "send",
                "--json",
                "--paste",
                "--exact-session",
                "--",
                "abc",
                "DECISION 1: a) yes\nDECISION 2: b) no",
            ],
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

    test("an original Claude receiver takes one literal media message without terminal lookup", async () => {
        const peer = {
            pid: 42,
            sessionId: "original-session",
            name: "fixture",
            cwd: "/fixture/project",
            status: "busy",
            kind: "interactive",
            socketPath: "/fixture/receiver.sock",
            file: "/fixture/home/sessions/42.json",
        };
        const received: unknown[] = [];
        const text = '<fromImage>\n{"path":"/fixture/c96d5e67-image.png"}\n</fromImage>';
        const result = await deliverToSession(
            { session: peer.sessionId, provider: "claude", sourceHome: "/fixture/home", text },
            {
                nativeWorkers: () => [],
                claudePeers: (home) => {
                    expect(home).toBe("/fixture/home");
                    return [peer];
                },
                peerToken: (_session, directory) => {
                    expect(directory).toBe("/fixture/home/sessions");
                    return null;
                },
                sendClaudePeer: async (input) => {
                    received.push(input);
                },
                receiverMode: async () => "prompting",
                findTargets: async () => {
                    throw new Error("Native delivery must not inspect terminals");
                },
                runTool: async () => {
                    throw new Error("Native delivery must not type a fallback");
                },
            }
        );
        expect(result).toEqual({ channel: "claude-peer", delivered: true, target: "original Claude session" });
        expect(received).toEqual([
            { session: peer, text, token: null, priority: "next", sender: null, timeoutMs: 5000 },
        ]);
    });

    // DECISION 25 a): a bypass receiver holds a plain frame for approval, so the answer carries a stand-in sender
    // of the receiver's class; a receiver of unknown class gets the plain frame as before.
    test("a bypass Claude receiver gets the answer from a stand-in bypass sender", async () => {
        const peer = {
            pid: 43,
            sessionId: "bypass-session",
            name: "fixture",
            cwd: "/fixture/project",
            status: "idle",
            kind: "interactive",
            socketPath: "/fixture/receiver.sock",
            file: "/fixture/home/sessions/43.json",
        };
        for (const [mode, attested] of [
            ["bypass", true],
            [null, false],
        ] as const) {
            const senders: unknown[] = [];
            await deliverToSession(
                { session: peer.sessionId, provider: "claude", sourceHome: "/fixture/home", text: "a)" },
                {
                    nativeWorkers: () => [],
                    claudePeers: () => [peer],
                    peerToken: () => null,
                    receiverMode: async (sessionId) => {
                        expect(sessionId).toBe(peer.sessionId);
                        return mode;
                    },
                    sendClaudePeer: async (input) => {
                        senders.push(input.sender);
                    },
                }
            );
            expect(senders).toEqual([attested ? standInSender("bypass") : null]);
        }
    });

    test("real native peer transport preserves a long Unicode reply as one user frame", async () => {
        const home = mkdtempSync(join(tmpdir(), "p-"));
        const socketPath = join(home, "p.sock");
        const frames: unknown[] = [];
        let accept!: (value: unknown) => void;
        const received = new Promise<unknown>((resolve) => {
            accept = resolve;
        });
        let buffered = "";
        const decoder = new TextDecoder();
        const server = Bun.listen({
            unix: socketPath,
            socket: {
                data(socket, bytes) {
                    buffered += decoder.decode(bytes, { stream: true });
                    const newline = buffered.indexOf("\n");
                    if (newline >= 0) {
                        const frame: unknown = SafeJSON.parse(buffered.slice(0, newline), { strict: true });
                        frames.push(frame);
                        accept(frame);
                        socket.end();
                    }
                },
            },
        });
        const peer = {
            pid: 42,
            sessionId: "fixture-original-session",
            name: null,
            cwd: null,
            status: "busy",
            kind: null,
            socketPath,
            file: join(home, "sessions/42.json"),
        };
        const text =
            "<fromVideo>\n" + "Literal line ž 漢字 /fixture/c96d5e67-image.png\n".repeat(1200) + "</fromVideo>";
        try {
            const result = await deliverToSession(
                { session: peer.sessionId, provider: "claude", sourceHome: home, text },
                {
                    nativeWorkers: () => [],
                    claudePeers: () => [peer],
                    peerToken: () => null,
                    findTargets: async () => {
                        throw new Error("A native socket must not use terminal delivery");
                    },
                }
            );
            expect(result).toMatchObject({ channel: "claude-peer", delivered: true });
            expect(await withTimeout(received, 5000)).toMatchObject({
                type: "user",
                session_id: peer.sessionId,
                message: { role: "user", content: text },
                priority: "next",
            });
            expect(frames).toHaveLength(1);
        } finally {
            server.stop(true);
        }
    });

    test("a failed native Claude write never retries through a terminal or a durable queue", async () => {
        const peer = {
            pid: 42,
            sessionId: "original-session",
            name: null,
            cwd: null,
            status: "busy",
            kind: null,
            socketPath: "/fixture/receiver.sock",
            file: "/fixture/home/sessions/42.json",
        };
        const queueRoot = mkdtempSync(join(tmpdir(), "peer-unknown-"));
        await expect(
            deliverToSession(
                {
                    session: peer.sessionId,
                    provider: "claude",
                    sourceHome: "/fixture/home",
                    text: "literal reply",
                    deliveryKey: "once",
                },
                {
                    queueRoot,
                    nativeWorkers: () => [],
                    claudePeers: () => [peer],
                    peerToken: () => null,
                    sendClaudePeer: async () => {
                        throw new Error("Disconnected after writing");
                    },
                    findTargets: async () => {
                        throw new Error("No terminal fallback after an uncertain write");
                    },
                }
            )
        ).rejects.toBeInstanceOf(DeliveryUnknownError);
        expect(
            listSessionMessages({
                root: queueRoot,
                target: { provider: "claude", sessionId: peer.sessionId, sourceHome: "/fixture/home" },
            })
        ).toEqual([]);
    });

    test("a native Claude receiver swap is refused at the consuming boundary", async () => {
        const peer = {
            pid: 42,
            sessionId: "original-session",
            name: null,
            cwd: null,
            status: "busy",
            kind: null,
            socketPath: "/fixture/receiver.sock",
            file: "/fixture/home/sessions/42.json",
        };
        let reads = 0;
        const result = await deliverToSession(
            { session: peer.sessionId, provider: "claude", sourceHome: "/fixture/home", text: "media reply" },
            {
                nativeWorkers: () => [],
                claudePeers: () =>
                    ++reads === 1 ? [peer] : [{ ...peer, pid: 43, socketPath: "/fixture/replacement.sock" }],
                sendClaudePeer: async () => {
                    throw new Error("The replacement must never receive a message");
                },
            }
        );
        expect(result).toMatchObject({
            delivered: false,
            error: "The native Claude receiver changed before delivery; no message was written.",
        });
        expect(reads).toBe(2);
    });

    test("native Claude routing rejects another home or duplicate receivers before any transport", async () => {
        const peer = {
            pid: 42,
            sessionId: "original-session",
            name: null,
            cwd: null,
            status: "busy",
            kind: null,
            socketPath: "/fixture/receiver.sock",
            file: "/fixture/other-home/sessions/42.json",
        };
        const request = { session: peer.sessionId, provider: "claude", sourceHome: "/fixture/home" };
        expect(
            await resolveDeliveryTarget(request, { nativeWorkers: () => [], claudePeers: () => [peer] })
        ).toMatchObject({ kind: "none", reason: "The native Claude receiver belongs to another source home." });
        expect(
            await resolveDeliveryTarget(request, { nativeWorkers: () => [], claudePeers: () => [peer, peer] })
        ).toMatchObject({
            kind: "none",
            reason: expect.stringMatching(/^2 Claude terminals run this session \(pid 42, pid 42\).*none was picked/),
        });
    });

    test("a session resumed in two terminals goes to the one active last, unless both moved recently", async () => {
        const base = {
            sessionId: "original-session",
            name: null,
            cwd: null,
            status: "idle",
            kind: null,
        };
        const stale = { ...base, pid: 41, socketPath: "/fixture/41.sock", file: "/fixture/home/sessions/41.json" };
        const active = { ...base, pid: 42, socketPath: "/fixture/42.sock", file: "/fixture/home/sessions/42.json" };
        const request = { session: "original-session", provider: "claude", sourceHome: "/fixture/home" };
        const now = 1_800_000_000_000;
        const picked = await resolveDeliveryTarget(request, {
            nativeWorkers: () => [],
            claudePeers: () => [
                { ...stale, updatedAt: now - 17 * 3600_000 },
                { ...active, updatedAt: now - 2 * 60_000 },
            ],
        });
        expect(picked).toMatchObject({ kind: "claude-peer", peer: { pid: 42 } });
        expect(picked.kind === "claude-peer" ? picked.label : "").toContain("1 older copy idle");

        expect(
            await resolveDeliveryTarget(request, {
                nativeWorkers: () => [],
                claudePeers: () => [
                    { ...stale, updatedAt: now - 3 * 60_000 },
                    { ...active, updatedAt: now - 60_000 },
                ],
            })
        ).toMatchObject({ kind: "none", reason: expect.stringContaining("pid 42, pid 41") });
    });

    test("a parked registry entry blocks even a live recorded terminal, while absent entries allow fallback", async () => {
        const home = mkdtempSync(join(tmpdir(), "parked-routing-"));
        const registry = {
            pid: 42,
            sessionId: "parked-session",
            messagingSocketPath: "/fixture/42.sock",
            parkedJobId: "background-job",
        };
        writeFileSync(join(home, "42.json"), SafeJSON.stringify(registry));
        const peers = () => listClaudeSessionInventory({ dir: home, liveOf: (pids) => new Set(pids) });
        const recorded = await livePaneTargets(registry.sessionId);
        recorded.source = "recorded";
        recorded.targets = recorded.targets.map((target) => ({ ...target, matchedOn: "recorded" }));
        recorded.snapshot = {
            fetchedAt: "2026-01-01T00:00:00Z",
            available: true,
            workspaces: [{ id: "ws-1", name: "work" }],
            panes: [
                {
                    id: "pane:1",
                    workspaceId: "ws-1",
                    title: "agent",
                    active: true,
                    surfaceCount: 1,
                    surfaces: [
                        {
                            id: "surface:1",
                            title: "agent",
                            type: "terminal",
                            index: 0,
                            selected: true,
                            active: true,
                        },
                    ],
                },
            ],
        };
        let socketWrites = 0;
        let terminalWrites = 0;
        let lookups = 0;
        const deps = {
            nativeWorkers: () => [],
            claudePeers: peers,
            peerToken: () => null,
            sendClaudePeer: async () => {
                socketWrites++;
            },
            findTargets: async () => {
                lookups++;
                return recorded;
            },
            runTool: async () => {
                terminalWrites++;
                return { success: true, stdout: '{"sent":true}', stderr: "" };
            },
        };
        const request = { session: registry.sessionId, provider: "claude", text: "decision answer" };
        expect(await deliverToSession(request, deps)).toMatchObject({
            channel: "queued",
            delivered: false,
            error: expect.stringContaining("parked in a background job"),
        });
        expect([socketWrites, terminalWrites, lookups]).toEqual([0, 0, 0]);

        // Control: the same recorded target remains a working fallback when no registry entry claims the session.
        expect(await deliverToSession(request, { ...deps, claudePeers: () => [] })).toMatchObject({
            channel: "cmux",
            delivered: true,
        });
        expect([socketWrites, terminalWrites, lookups]).toEqual([0, 1, 1]);

        // A live, unparked copy of the same session is still a valid receiver.
        writeFileSync(
            join(home, "43.json"),
            SafeJSON.stringify({
                ...registry,
                pid: 43,
                messagingSocketPath: "/fixture/43.sock",
                parkedJobId: undefined,
            })
        );
        expect(await deliverToSession(request, deps)).toMatchObject({ channel: "claude-peer", delivered: true });
        expect([socketWrites, terminalWrites, lookups]).toEqual([1, 1, 1]);
    });

    test("a Claude receiver that parks before the consuming write is refused", async () => {
        const home = mkdtempSync(join(tmpdir(), "parking-race-"));
        const file = join(home, "42.json");
        const registry = { pid: 42, sessionId: "parking-session", messagingSocketPath: "/fixture/42.sock" };
        writeFileSync(file, SafeJSON.stringify(registry));
        let reads = 0;
        let writes = 0;
        const result = await deliverToSession(
            { session: registry.sessionId, provider: "claude", text: "answer" },
            {
                nativeWorkers: () => [],
                claudePeers: () => {
                    const peers = listClaudeSessionInventory({ dir: home, liveOf: (pids) => new Set(pids) });
                    if (++reads === 1) {
                        writeFileSync(file, SafeJSON.stringify({ ...registry, parkedJobId: "background-job" }));
                    }

                    return peers;
                },
                peerToken: () => null,
                sendClaudePeer: async () => {
                    writes++;
                },
                runTool: async () => {
                    writes++;
                    return { success: true, stdout: '{"sent":true}', stderr: "" };
                },
            }
        );
        expect(result).toMatchObject({ delivered: false, error: expect.stringContaining("receiver changed") });
        expect(reads).toBe(2);
        expect(writes).toBe(0);
    });

    test("duplicate Claude receivers need a valid activity timestamp on every copy", async () => {
        const peer = {
            sessionId: "original-session",
            name: null,
            cwd: null,
            status: "idle",
            kind: null,
            pid: 42,
            socketPath: "/fixture/42.sock",
            file: "/fixture/home/sessions/42.json",
            updatedAt: 1_800_000_000_000,
        };
        const request = { session: peer.sessionId, provider: "claude", sourceHome: "/fixture/home", text: "reply" };
        for (const updatedAt of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
            const unknown = { ...peer, pid: 43, socketPath: "/fixture/43.sock", updatedAt };
            for (const peers of [
                [peer, unknown],
                [unknown, peer],
                [peer, { ...peer, pid: 44, updatedAt: 1 }, unknown],
            ]) {
                let sends = 0;
                const result = await deliverToSession(request, {
                    nativeWorkers: () => [],
                    claudePeers: () => peers,
                    peerToken: () => null,
                    sendClaudePeer: async () => {
                        sends++;
                    },
                });
                expect(result).toMatchObject({ delivered: false, error: expect.stringContaining("none was picked") });
                expect(sends).toBe(0);
            }
        }

        let reads = 0;
        const changed = await deliverToSession(request, {
            nativeWorkers: () => [],
            claudePeers: () => [peer, { ...peer, pid: 43, updatedAt: ++reads === 1 ? 1 : undefined }],
            sendClaudePeer: async () => {
                throw new Error("Unknown recency at the consuming boundary must prevent a write");
            },
        });
        expect(changed).toMatchObject({ delivered: false, error: expect.stringContaining("receiver changed") });
        expect(reads).toBe(2);
    });

    test("automatic replies never type into a lone cwd or screen-text match", async () => {
        for (const source of ["cwd", "screen"] as const) {
            let sends = 0;
            const result = await deliverToSession(
                { session: "original-session", provider: "claude", text: "media reply" },
                {
                    findTargets: async (session) => ({ ...(await livePaneTargets(session)), source }),
                    runTool: async () => {
                        sends++;
                        return { success: true, stdout: '{"sent":true}', stderr: "" };
                    },
                }
            );
            expect(result).toMatchObject({
                delivered: false,
                error: "the cmux match does not identify the exact recipient session",
            });
            expect(sends).toBe(0);
        }
    });

    test("automatic replies judge the evidence, not the stage: a printed id or a topic title is refused", async () => {
        for (const matchedOn of ["session-id", "id-prefix", "session-name", "pane-title"] as const) {
            let sends = 0;
            const result = await deliverToSession(
                { session: "original-session", provider: "claude", text: "media reply" },
                {
                    findTargets: async (session) => {
                        const live = await livePaneTargets(session);
                        return { ...live, targets: live.targets.map((target) => ({ ...target, matchedOn })) };
                    },
                    runTool: async () => {
                        sends++;
                        return { success: true, stdout: '{"sent":true}', stderr: "" };
                    },
                }
            );
            expect(result).toMatchObject({
                delivered: false,
                error: "the cmux match does not identify the exact recipient session",
            });
            expect(sends).toBe(0);
        }

        // Control: the same lone pane proven by the id `restore` stamps into its tab title still receives the reply.
        let sends = 0;
        const proven = await deliverToSession(
            { session: "original-session", provider: "claude", text: "media reply" },
            {
                findTargets: livePaneTargets,
                runTool: async () => {
                    sends++;
                    return { success: true, stdout: '{"sent":true}', stderr: "" };
                },
            }
        );
        expect(proven).toMatchObject({ channel: "cmux", delivered: true });
        expect(sends).toBe(1);
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

    test("a message over the queue limit is reported as not saved and not sent, yet a live pane still takes it", async () => {
        const queueRoot = mkdtempSync(join(tmpdir(), "oversized-queue-"));
        const request = {
            session: "abc",
            provider: "claude",
            text: "あ".repeat(24_000),
            sourceHome: "/fixture/claude",
            deliveryKey: "oversized-key",
        };
        const unsaved = await deliverToSession(request, { findTargets: noPaneTargets, queueRoot });

        expect(unsaved).toMatchObject({
            channel: "queued",
            delivered: false,
            error: expect.stringContaining("too large to save"),
        });
        expect(unsaved.queueId).toBeUndefined();
        expect(
            listSessionMessages({
                target: { provider: "claude", sessionId: "abc", sourceHome: "/fixture/claude" },
                root: queueRoot,
            })
        ).toEqual([]);

        const live = await deliverToSession(request, {
            findTargets: livePaneTargets,
            runTool: spy({ success: true, stdout: '{"sent":true}' }).runTool,
            queueRoot,
        });
        expect(live).toMatchObject({ channel: "cmux", delivered: true });
    });

    test("a retry of a key an earlier attempt already saved stays in the queue, even when a live pane appears", async () => {
        const queueRoot = mkdtempSync(join(tmpdir(), "keyed-retry-queue-"));
        const request = {
            session: "abc",
            provider: "claude",
            text: "DECISION 1: a) yes",
            sourceHome: "/fixture/claude",
            deliveryKey: "fixture-key",
        };
        const first = await deliverToSession(request, { findTargets: noPaneTargets, queueRoot });
        expect(first.queueId).toBeDefined();
        const never = async (): Promise<never> => {
            throw new Error("must not type a message that is already queued");
        };
        const retry = await deliverToSession(request, { runTool: never, findTargets: livePaneTargets, queueRoot });

        expect(retry).toMatchObject({ channel: "queued", delivered: false, queueId: first.queueId });
        expect(
            listSessionMessages({
                target: { provider: "claude", sessionId: "abc", sourceHome: "/fixture/claude" },
                root: queueRoot,
            })
        ).toHaveLength(1);
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

    test("a Codex worker whose daemon is gone is no route and the answer is queued, while a live daemon is still the route", async () => {
        const home = mkdtempSync(join(tmpdir(), "codex-worker-liveness-"));
        const queueRoot = mkdtempSync(join(tmpdir(), "codex-worker-liveness-queue-"));
        const sourceHome = join(home, "codex-home");
        const gone = Bun.spawn(["true"], { env: process.env });
        await gone.exited;
        const alive = Bun.spawn(
            [process.execPath, "-e", "setTimeout(() => {}, 60000)", "--name", "live-worker", "codex-daemon"],
            { stdout: "ignore", stderr: "ignore", env: process.env }
        );
        const worker = (name: string, daemonPid: number, threadId: string): CodexSessionMeta => ({
            name,
            daemonPid,
            threadId,
            home: sourceHome,
            cwd: "/fixture/project",
            sandbox: "read-only",
            approvalPolicy: "never",
            writePolicy: "deny",
            status: "ready",
            agentName: name,
            rendezvousSession: "fixture-parent",
            agentsEnabled: false,
            startedAt: "2026-01-01T00:00:00.000Z",
            lastEventAt: "2026-01-01T00:00:00.000Z",
            codexVersion: "0.159.2",
            pendingApprovals: {},
        });

        try {
            await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, async () => {
                const store = new CodexSessionStore();
                store.writeMeta(worker("stale-worker", gone.pid, "thread-stale"));
                store.writeMeta(worker("live-worker", alive.pid, "thread-live"));

                expect(
                    await resolveDeliveryTarget({ session: "thread-stale", provider: "codex", sourceHome })
                ).toMatchObject({ kind: "none" });
                expect(
                    await resolveDeliveryTarget({ session: "thread-live", provider: "codex", sourceHome })
                ).toMatchObject({ kind: "codex", worker: "live-worker" });

                const never = async (): Promise<never> => {
                    throw new Error("must not run a tool for a worker whose daemon is gone");
                };
                const queued = await deliverToSession(
                    {
                        session: "thread-stale",
                        provider: "codex",
                        sourceHome,
                        text: "DECISION 1: a) yes",
                        deliveryKey: "stale-key",
                    },
                    { runTool: never, queueRoot }
                );
                expect(queued).toMatchObject({ channel: "queued", delivered: false });
                expect(queued.queueId).toBeDefined();
            });
        } finally {
            alive.kill();
        }
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
    await expect(pending).rejects.toThrow("DECISION 1 changed: the agent posted a new text");
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
        `${[decision, todo]
            .map((row) => SafeJSON.stringify({ ...row, state: "answered", option: "a", answeredVia: "inbox" }))
            .join("\n")}\n`
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
            { ...open, state: "answered", option: "a", answeredVia: "inbox" },
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
    await expect(updateDecision(file, events, row.id, { state: "implemented" })).rejects.toThrow(
        "reserved by a queued delivery"
    );
});

test("an answer the agent got in chat moves to acknowledged and implemented without a send", async () => {
    const dir = mkdtempSync(join(tmpdir(), "decision-chat-answer-"));
    const file = join(dir, "decisions.jsonl");
    const events = join(dir, "events.jsonl");
    const [first, second] = await postDecisions(file, events, {
        sessionId: "test-session",
        decisions: [
            { prompt: "First?", options: ["yes"] },
            { prompt: "Second?", options: ["no"] },
        ],
    });
    for (const row of [first, second]) {
        await updateDecision(file, events, row.id, { state: "answered", answer: "yes" });
    }

    expect((await updateDecision(file, events, first.id, { state: "acknowledged" })).state).toBe("acknowledged");
    expect((await updateDecision(file, events, first.id, { state: "implemented" })).state).toBe("implemented");
    expect((await updateDecision(file, events, second.id, { state: "implemented" })).state).toBe("implemented");
});

describe("answers recorded by an agent, and superseded decisions", () => {
    async function fixture(prompts: string[]) {
        const dir = mkdtempSync(join(tmpdir(), "decision-recorded-"));
        const file = join(dir, "decisions.jsonl");
        const events = join(dir, "events.jsonl");
        const rows = await postDecisions(file, events, {
            sessionId: "recorded-session",
            decisions: prompts.map((prompt) => ({ prompt, options: ["keep", "drop"] })),
        });
        return { file, events, rows };
    }

    test("open and drafted move straight to acknowledged with the chat answer, marked agent, and nothing is due", async () => {
        const { file, events, rows } = await fixture(["Open one?", "Drafted one?", "No answer?"]);
        const [open, drafted, bare] = rows;
        await updateDecision(file, events, drafted.id, { state: "drafted", draft: "maybe", draftOption: "a" });

        const fromOpen = await updateDecision(file, events, open.id, {
            state: "acknowledged",
            option: "b",
            answer: "drop it, said in chat",
        });
        const [fromDrafted] = await updateDecisions(file, events, {
            updates: [{ id: drafted.id, state: "acknowledged", option: "a" }],
        });

        expect(fromOpen).toMatchObject({ state: "acknowledged", option: "b", answeredVia: "agent" });
        expect(fromDrafted).toMatchObject({ state: "acknowledged", option: "a", answeredVia: "agent" });
        // The widget shows a chat answer by the time it was recorded, which a later update must not move.
        expect(fromOpen.answeredTs).toBe(fromOpen.updatedTs);
        const implemented = await updateDecision(file, events, open.id, { state: "implemented", comment: "done" });
        expect(implemented.answeredTs).toBe(fromOpen.answeredTs);
        expect(fromDrafted.draft).toBeUndefined();
        expect(fromDrafted.draftOption).toBeUndefined();
        await expect(updateDecision(file, events, bare.id, { state: "acknowledged" })).rejects.toThrow(
            "without the user's answer"
        );
        // Every send reads `answered` rows only: a recorded chat answer is never typed back into the agent.
        expect(() => deliverDecisions(readDecisions(file), () => undefined)).toThrow("nothing to send");
    });

    test("the inbox answer path marks its answer inbox, and a later acknowledge keeps that mark", async () => {
        const { file, events, rows } = await fixture(["Inbox?"]);
        const answered = await updateDecision(file, events, rows[0].id, { state: "answered", option: "a" });
        expect(answered.answeredVia).toBe("inbox");
        expect(answered.answeredTs).toBe(answered.updatedTs);
        const acknowledged = await updateDecision(file, events, rows[0].id, { state: "acknowledged" });
        expect(acknowledged.answeredVia).toBe("inbox");
        expect(acknowledged.answeredTs).toBe(answered.answeredTs);
    });

    test("superseded needs a link or a reason, and the link must name another stored decision", async () => {
        const { file, events, rows } = await fixture(["Old?", "New?"]);
        const [old, replacement] = rows;
        const [elsewhere] = await postDecisions(file, events, {
            sessionId: "other-session",
            decisions: [{ prompt: "Elsewhere?", options: [] }],
        });

        await expect(updateDecision(file, events, old.id, { state: "superseded" })).rejects.toThrow(
            "without supersededBy or a comment"
        );
        await expect(
            updateDecision(file, events, old.id, { state: "superseded", supersededBy: "d_99_recorded-session" })
        ).rejects.toThrow("names no stored decision");
        await expect(
            updateDecision(file, events, old.id, { state: "superseded", supersededBy: old.id })
        ).rejects.toThrow("superseded by itself");
        await expect(updateDecision(file, events, old.id, { supersededBy: replacement.id })).rejects.toThrow(
            "goes with state superseded"
        );
        expect(readDecisions(file).find((row) => row.id === old.id)?.state).toBe("open");

        const moved = await updateDecision(file, events, old.id, {
            state: "superseded",
            supersededBy: elsewhere.id,
            comment: "the other session decides it",
        });
        expect(moved).toMatchObject({
            state: "superseded",
            supersededBy: elsewhere.id,
            comments: ["the other session decides it"],
        });
        // Terminal: nothing moves out of it.
        await expect(updateDecision(file, events, old.id, { state: "acknowledged", option: "a" })).rejects.toThrow(
            "cannot move"
        );
        expect(decisionsMarkdown([moved])).toContain(`superseded by ${elsewhere.id}: the other session decides it`);
        expect(
            listSessions(readDecisions(file), { status: ["superseded"] })[0]?.decisions.map((row) => row.id)
        ).toEqual([old.id]);
    });

    test("superseded is legal from open, drafted, sent and acknowledged, and never for an answered row or a todo", async () => {
        const { file, events, rows } = await fixture(["Open?", "Drafted?", "Sent?", "Acked?", "Answered?", "Done?"]);
        const [open, drafted, sent, acked, answered, done] = rows;
        await updateDecision(file, events, drafted.id, { state: "drafted", draftOption: "a" });
        for (const row of [sent, acked, answered, done]) {
            await updateDecision(file, events, row.id, { state: "answered", option: "a" });
        }
        await moveDecisions(file, events, [sent.id, acked.id], "sent");
        await updateDecision(file, events, acked.id, { state: "acknowledged" });
        await updateDecision(file, events, done.id, { state: "implemented" });

        const why = { state: "superseded" as const, comment: "replaced" };
        const moved = await updateDecisions(file, events, {
            updates: [open, drafted, sent, acked].map((row) => ({ id: row.id, ...why })),
        });
        expect(moved.map((row) => row.state)).toEqual(["superseded", "superseded", "superseded", "superseded"]);
        expect(moved[1].draftOption).toBeUndefined();
        for (const row of [answered, done]) {
            await expect(updateDecision(file, events, row.id, why)).rejects.toThrow("cannot move");
        }

        const [todo] = await postDecisions(file, events, {
            sessionId: "recorded-session",
            decisions: [{ type: "todo", prompt: "Ship it", options: [] }],
        });
        await expect(updateDecision(file, events, todo.id, why)).rejects.toThrow("cannot move");
    });
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

    test("a task's session is trimmed once, so it numbers on with that session's tasks", async () => {
        const { files } = fixture();
        const next = await createTodo({
            ...files,
            todo: { title: "Next step", sessionId: " fixture ", provider: "codex" },
        });
        expect(next).toMatchObject({ id: "t_2_fixture", sessionId: "fixture", number: 2 });
    });

    test("a created task is numbered per session, lists as active and ticks done through the same guards", async () => {
        const { files, row } = fixture();
        const now = () => "2026-01-02T09:00:00.000Z";
        const local = await createWidgetTask({ files, now, input: { title: "  Water the plants  " } });
        expect(local.task).toMatchObject({
            id: "t_1_local",
            title: "Water the plants",
            summary: "Water the plants",
            state: "open",
            revision: 1,
            sessionId: LOCAL_TASK_SESSION,
            provider: "unknown",
            sessionTitle: "Local tasks",
        });
        expect(local.receipt).toMatchObject({ action: "create", state: "open", saved: true });
        const onSession = await createWidgetTask({
            files,
            now,
            input: {
                title: "Review the draft",
                details: "Read the summary before sending it.",
                session: "codex:fixture",
                project: "Fixture",
                cwd: "/fixture/worktree",
            },
        });
        // The fixture session already holds TODO 1, so the next number is 2; a number is never reused.
        expect(onSession.task).toMatchObject({
            id: "t_2_fixture",
            number: 2,
            title: "Review the draft",
            summary: "Read the summary before sending it.",
            provider: "codex",
        });
        expect(onSession.task.sourceContext).toMatchObject({ project: "Fixture", cwd: "/fixture/worktree" });
        const listed = listWidgetTasks({ file: files.file, filters: { sessions: ["codex:fixture"] } });
        expect(listed.tasks.map((task) => task.id).sort()).toEqual([row.id, "t_2_fixture"]);
        const events = readFileSync(files.events, "utf8")
            .trim()
            .split("\n")
            .map((entry) => SafeJSON.parse(entry));
        expect(events.map((event) => event.ev)).toEqual(["created", "created"]);

        const done = await updateWidgetTask({
            files,
            input: {
                id: local.task.id,
                action: "complete",
                expected: {
                    revision: local.task.revision,
                    state: local.task.state,
                    updatedTs: local.task.updatedTs,
                    sessionId: local.task.sessionId,
                    provider: local.task.provider,
                },
            },
        });
        expect(done.task.state).toBe("implemented");
        expect(listWidgetTasks({ file: files.file, filters: { scope: "completed" } }).tasks[0]?.id).toBe("t_1_local");
    });

    test("an invalid create stores nothing", async () => {
        const { files } = fixture();
        const before = readFileSync(files.file, "utf8");
        for (const input of [
            { title: "   " },
            { title: "x".repeat(181) },
            { title: "Fine", session: "no-provider" },
            { title: "Fine", details: "y".repeat(2001) },
        ]) {
            await expect(createWidgetTask({ files, input })).rejects.toThrow();
        }
        expect(readFileSync(files.file, "utf8")).toBe(before);
        expect(existsSync(files.events)).toBe(false);
    });

    test("editing an open task keeps the earlier text as a version and refuses a stale or finished one", async () => {
        const { files, row } = fixture();
        const shown = expected(row);
        const edited = await editWidgetTask({
            files,
            now: () => row.updatedTs,
            input: { id: row.id, title: "Verify every change", details: "Run the checks twice.", expected: shown },
        });
        expect(edited.task).toMatchObject({
            title: "Verify every change",
            summary: "Run the checks twice.",
            revision: 2,
            state: "open",
        });
        expect(Date.parse(edited.task.updatedTs)).toBeGreaterThan(Date.parse(row.updatedTs));
        const stored = readDecisions(files.file)[0];
        expect(stored?.versions?.[0]).toMatchObject({
            prompt: "Run the local checks",
            title: "Verify changes",
            revision: 1,
        });
        expect(stored?.blocking).toBe(true);
        expect(stored?.branch).toBe("feat/example");

        const before = readFileSync(files.file, "utf8");
        await expect(
            editWidgetTask({ files, input: { id: row.id, title: "Stale edit", expected: shown } })
        ).rejects.toThrow("changed since");
        expect(readFileSync(files.file, "utf8")).toBe(before);

        const titleOnly = await editWidgetTask({
            files,
            input: { id: row.id, title: "Only a title", expected: expected(stored as DecisionRecord) },
        });
        expect(titleOnly.task).toMatchObject({ title: "Only a title", summary: "Only a title", revision: 3 });

        const finished = await updateTodo({
            ...files,
            id: row.id,
            state: "implemented",
            expected: expected(readDecisions(files.file)[0] as DecisionRecord),
        });
        await expect(
            editWidgetTask({ files, input: { id: row.id, title: "Too late", expected: expected(finished) } })
        ).rejects.toThrow("Only an open task");
    });

    test("a task the widget shows as an excerpt cannot be edited there, so its full text is never cut", async () => {
        const { files, row } = fixture();
        const long: DecisionRecord = { ...row, prompt: `${"Check every step. ".repeat(150)}The last line.` };
        writeFileSync(files.file, `${SafeJSON.stringify(long)}\n`);
        expect(listWidgetTasks({ file: files.file }).tasks[0]?.truncated).toBe(true);
        const before = readFileSync(files.file, "utf8");
        await expect(
            editWidgetTask({ files, input: { id: row.id, title: "Shorter title", expected: expected(long) } })
        ).rejects.toThrow("longer than the widget shows (2000 characters)");
        expect(readFileSync(files.file, "utf8")).toBe(before);

        const longTitle: DecisionRecord = { ...row, title: "t".repeat(200) };
        writeFileSync(files.file, `${SafeJSON.stringify(longTitle)}\n`);
        expect(listWidgetTasks({ file: files.file }).tasks[0]?.truncated).toBe(true);
        await expect(
            editWidgetTask({ files, input: { id: row.id, title: "t".repeat(180), expected: expected(longTitle) } })
        ).rejects.toThrow("longer than the widget shows (a 180-character title)");
    });
});

test("chat answers cannot acknowledge a revision that replaced the matched question", async () => {
    const dir = mkdtempSync(join(tmpdir(), "decisions-chat-revision-"));
    const file = join(dir, "decisions.jsonl");
    const events = join(dir, "events.jsonl");
    const [original] = await postDecisions(file, events, {
        sessionId: "s",
        decisions: [{ prompt: "Keep?", options: ["yes", "no"] }],
    });
    const answer = {
        id: original.id,
        expectedRevision: original.revision ?? 1,
        option: "b",
        answer: "",
        evidence: { text: "D1 b)" },
    };
    const [revised] = await postDecisions(file, events, {
        sessionId: "s",
        decisions: [{ prompt: "Ship?", options: ["later", "now"], supersedes: original.id }],
    });

    expect(await recordChatAnswers({ file, events, answers: [answer] })).toEqual([]);
    expect(readDecisions(file)[0]).toEqual(revised);
    expect(
        await recordChatAnswers({ file, events, answers: [{ ...answer, expectedRevision: revised.revision ?? 1 }] })
    ).toMatchObject([{ id: original.id, state: "acknowledged", option: "b", answeredVia: "automatic_heuristic" }]);
});

describe("chatAnswers", () => {
    const at = (minute: number) => `2026-10-25T16:${String(minute).padStart(2, "0")}:00.000Z`;
    const entry = (role: NativeHistoryEntry["role"], text: string, minute?: number): NativeHistoryEntry => ({
        line: minute ?? -1,
        role,
        text,
        paths: [],
        commits: [],
        ...(minute === undefined ? {} : { timestamp: at(minute) }),
    });
    const two = ["a", "b"];

    test("reads the forms people type, several on one line, and only after the ask", () => {
        const found = chatAnswers(
            [
                entry("user", "D14 a) before it was asked", 1),
                entry("assistant", "❓ DECISION 14 …\n❓ DECISION 15 …\n❓ DECISION 16 …", 2),
                entry("user", "D14 b - smaller, D15 a\n16 b", 3),
                entry("assistant", "Recap: [❓ DECISION 14](link) is decided.", 4),
            ],
            [
                { number: 14, letters: two, askedAt: at(2) },
                { number: 15, letters: two, askedAt: at(2) },
                { number: 16, letters: two, askedAt: at(2) },
            ]
        );

        expect(found.ambiguous).toEqual([]);
        expect(found.unambiguous.map((answer) => [answer.number, answer.option, answer.answer])).toEqual([
            [14, "b", "smaller"],
            [15, "a", ""],
            [16, "b", ""],
        ]);
    });

    test("calls two answers, a letter past the options, or a bare mention ambiguous", () => {
        const found = chatAnswers(
            [
                entry("assistant", "❓ DECISION 1 ❓ DECISION 2 ❓ DECISION 3", 1),
                entry("user", "D1 a)", 2),
                entry("user", "actually D1 b) and\n2 z)\nD3 needs more thought", 3),
            ],
            [
                { number: 1, letters: two, askedAt: at(1) },
                { number: 2, letters: two, askedAt: at(1) },
                { number: 3, letters: two, askedAt: at(1) },
            ]
        );

        // `actually D1 b)` does not open its line, so D1 has one answer; `2 z)` is past b; D3 is named without one.
        expect(found.unambiguous.map((answer) => [answer.number, answer.option])).toEqual([[1, "a"]]);
        expect(found.ambiguous.map((item) => [item.number, item.reason])).toEqual([
            [2, "unknown option"],
            [3, "mentioned without an option"],
        ]);
    });

    test("takes a bare `b)` only after a reply that asked one decision, and skips harness text", () => {
        const one = chatAnswers(
            [
                entry("assistant", "❓ DECISION 7 — Keep?\n- a) yes\n- b) no", 1),
                entry("user", "<system-reminder>D7 a)</system-reminder>", 2),
                entry("user", "b) no, drop it", 3),
            ],
            [{ number: 7, letters: two, askedAt: at(1) }]
        );
        const several = chatAnswers(
            [entry("assistant", "❓ DECISION 7 ❓ DECISION 8", 1), entry("user", "b)", 2)],
            [{ number: 7, letters: two, askedAt: at(1) }]
        );

        expect(one.unambiguous).toMatchObject([{ number: 7, option: "b", answer: "no, drop it" }]);
        expect(several).toEqual({ unambiguous: [], ambiguous: [] });
    });

    test("reads bare answers against every text block of one assistant message", () => {
        const block = (text: string) => ({ ...entry("assistant", text, 1), line: -2 });
        const open = [{ number: 7, letters: two, askedAt: at(1) }];
        const answer = entry("user", "b)", 2);
        const one = [block("❓ DECISION 7 — Keep?"), block("- a) yes\n- b) no")];

        expect(chatAnswers([...one, answer], open).unambiguous).toMatchObject([{ number: 7, option: "b" }]);
        expect(
            chatAnswers([...one, block("❓ DECISION 7 is yours to decide"), answer], open).unambiguous
        ).toMatchObject([{ number: 7, option: "b" }]);
        expect(chatAnswers([block("❓ DECISION 8 — Ship?"), ...one, answer], open)).toEqual({
            unambiguous: [],
            ambiguous: [],
        });
        expect(
            chatAnswers(
                [...one, entry("assistant", "Choose a color: a) red, b) blue", 2), entry("user", "b)", 3)],
                open
            )
        ).toEqual({
            unambiguous: [],
            ambiguous: [],
        });
    });

    test("keeps fenced examples excluded when their fence spans text blocks of a message", () => {
        const userBlock = (text: string) => ({ ...entry("user", text, 2), line: -1 });
        const result = chatAnswers(
            [
                entry("assistant", "❓ DECISION 7", 1),
                userBlock("Why did this example fail?\n```text"),
                userBlock("D7 b)\n```"),
            ],
            [{ number: 7, letters: two, askedAt: at(1) }]
        );

        expect(result).toEqual({ unambiguous: [], ambiguous: [] });
    });

    test("keeps colon-prefixed own words distinct from an option with a delimited explanation", () => {
        for (const letters of [[], two]) {
            for (const prefix of ["D4", "DECISION 4"]) {
                for (const answer of ["I prefer Atlas", "a different name", "b would be better"]) {
                    const result = chatAnswers(
                        [entry("user", `${prefix}: ${answer}`, 2)],
                        [{ number: 4, letters, askedAt: at(1) }]
                    );

                    expect(result.ambiguous).toEqual([]);
                    expect(result.unambiguous).toMatchObject([{ number: 4, answer }]);
                    expect(result.unambiguous[0]?.option).toBeUndefined();
                }
            }
        }

        for (const text of ["D4: a - keep it", "DECISION 4: a - keep it", "D4 a: keep it", "D4 a) keep it"]) {
            expect(
                chatAnswers([entry("user", text, 2)], [{ number: 4, letters: two, askedAt: at(1) }]).unambiguous
            ).toMatchObject([{ number: 4, option: "a", answer: "keep it" }]);
        }

        expect(
            chatAnswers([entry("user", "DECISION 4: b", 2)], [{ number: 4, letters: two, askedAt: at(1) }]).unambiguous
        ).toMatchObject([{ number: 4, option: "b", answer: "" }]);
        const free = chatAnswers([entry("user", "D4: I", 2)], [{ number: 4, letters: [], askedAt: at(1) }]);
        expect(free.unambiguous).toMatchObject([{ number: 4, answer: "I" }]);
        expect(free.unambiguous[0]?.option).toBeUndefined();
    });

    test("ignores fenced, quoted, inline and indented examples while keeping actual answers", () => {
        for (const example of [
            "Why did this example fail?\n```text\nD14 b)\n```",
            "Why did this example fail?\n~~~~text\nD14 b)\n~~~~",
            "> example, D14 b)",
            "`D14 b)`",
            "    D14 b)",
            "Why did this fail?\n```\nD14 b)\n~~~\nD14 a)\n```",
        ]) {
            const entries = [entry("assistant", "❓ DECISION 14", 1), entry("user", example, 2)];
            expect(chatAnswers(entries, [{ number: 14, letters: two, askedAt: at(1) }])).toEqual({
                unambiguous: [],
                ambiguous: [],
            });
            expect(
                chatAnswers(
                    [...entries, entry("user", "D14 a) keep it", 3)],
                    [{ number: 14, letters: two, askedAt: at(1) }]
                ).unambiguous
            ).toMatchObject([{ number: 14, option: "a" }]);
        }
    });

    test("expires a bare option after an unrelated assistant reply or a real user response", () => {
        for (const intervening of [
            [entry("assistant", "Choose a color: a) red or b) blue", 2)],
            [entry("user", "Tell me about the cache first", 2)],
        ]) {
            expect(
                chatAnswers(
                    [entry("assistant", "❓ DECISION 7 — Keep?", 1), ...intervening, entry("user", "b)", 3)],
                    [{ number: 7, letters: two, askedAt: at(1) }]
                )
            ).toEqual({ unambiguous: [], ambiguous: [] });
        }
    });

    test("revised decisions require timestamps instead of reusing the first numbered ask", () => {
        const open = [{ number: 4, letters: two, revision: 2, askedAt: at(3) }];
        const old = [
            entry("assistant", "❓ DECISION 4 — Keep?"),
            entry("user", "D4 b)"),
            entry("assistant", "❓ DECISION 4 — Ship?"),
        ];
        expect(chatAnswers(old, open)).toEqual({ unambiguous: [], ambiguous: [] });
        // Even a later answer has no trustworthy revision boundary when the transcript has no timestamps.
        expect(chatAnswers([...old, entry("user", "D4 a)")], open)).toEqual({ unambiguous: [], ambiguous: [] });

        const timed = chatAnswers(
            [
                entry("assistant", "❓ DECISION 4 — Keep?", 1),
                entry("user", "D4 b)", 2),
                entry("assistant", "❓ DECISION 4 — Ship?", 3),
                entry("user", "D4 a)", 4),
            ],
            open
        );
        expect(timed.ambiguous).toEqual([]);
        expect(timed.unambiguous).toMatchObject([{ number: 4, option: "a" }]);
    });

    test("counts from the first ask when the entries carry no time (Grok), and takes own words", () => {
        const found = chatAnswers(
            [
                entry("user", "D4: before"),
                entry("assistant", "❓ DECISION 4 — Name it"),
                entry("user", "D4: call it Atlas"),
            ],
            [{ number: 4, letters: [], askedAt: at(1) }]
        );

        expect(found.unambiguous).toMatchObject([{ number: 4, answer: "call it Atlas" }]);
        expect(found.unambiguous[0]?.option).toBeUndefined();
    });
});

describe("chat answers an agent records are never sent again (F2)", () => {
    test("an agent's answered or sent lands as acknowledged; the inbox's own answer still waits to go out", async () => {
        const { file, events } = scratch();
        await postDecisions(file, events, {
            sessionId: "abc",
            decisions: [
                { prompt: "one", options: ["keep", "drop"] },
                { prompt: "two", options: ["a", "b"] },
            ],
        });

        const [agent] = await updateDecisions(
            file,
            events,
            { updates: [{ id: "d_1_abc", state: "answered", option: "b", answer: "drop it" }] },
            undefined,
            { actor: "agent" }
        );
        expect(agent).toMatchObject({ state: "acknowledged", option: "b", answer: "drop it", answeredVia: "agent" });
        expect(agent?.comments?.at(-1)).toContain("an agent asked for answered");
        expect(awaitsDelivery(agent as DecisionRecord)).toBe(false);

        // Negative control: the user's path (the store's default actor) still queues the answer for a send.
        const [user] = await updateDecisions(file, events, {
            updates: [{ id: "d_2_abc", state: "answered", option: "a" }],
        });
        expect(user).toMatchObject({ state: "answered", answeredVia: "inbox" });
        expect(awaitsDelivery(user as DecisionRecord)).toBe(true);
        expect(stagedSendText(readDecisions(file), "abc")).toBe("DECISION 2: a) a");
    });

    test("an old-shape chat answer (answered, no answeredVia, no delivery) is left out of every whole-session send", () => {
        const chat: DecisionRecord = { ...foreignRow("abc", 1), state: "answered", option: "a" };
        const inbox: DecisionRecord = { ...foreignRow("abc", 2), state: "answered", option: "a", answeredVia: "inbox" };

        expect(awaitsDelivery(chat)).toBe(false);
        expect(awaitsDelivery(inbox)).toBe(true);
        expect(stagedSendText([chat, inbox], "abc")).toBe("DECISION 2: a) a");
        expect(stagedSendText([chat], "abc")).toBeUndefined();
    });

    test("the repair reports first, then acknowledges old chat answers and reopens empty drafts, keeping history", async () => {
        const { file, events } = scratch();
        const rows: DecisionRecord[] = [
            { ...foreignRow("abc", 1), state: "answered", option: "a", answer: "yes" },
            { ...foreignRow("abc", 2), state: "answered", option: "a", answeredVia: "inbox" },
            {
                ...foreignRow("abc", 3),
                state: "answered",
                option: "a",
                delivery: { route: "cmux", uncertain: true, at: "2026-01-01T00:00:00.000Z" },
            },
            { ...foreignRow("abc", 4), state: "drafted", draft: "", draftOption: "" },
            { ...foreignRow("abc", 5), state: "drafted", draftOption: "a" },
        ];
        writeFileSync(file, `${rows.map((row) => SafeJSON.stringify(row)).join("\n")}\n`);
        const before = readFileSync(file, "utf8");

        const dry = await repairDecisionLog({ file, events, apply: false });
        expect(dry).toEqual({ acknowledged: ["d_1_abc"], reopened: ["d_4_abc"] });
        expect(readFileSync(file, "utf8")).toBe(before);
        expect(existsSync(events)).toBe(false);

        const applied = await repairDecisionLog({ file, events, apply: true, now: () => "2026-01-02T00:00:00.000Z" });
        expect(applied).toEqual(dry);
        const after = readDecisions(file);
        expect(after.map((row) => row.state)).toEqual(["acknowledged", "answered", "answered", "open", "drafted"]);
        expect(after[0]).toMatchObject({
            option: "a",
            answer: "yes",
            answeredVia: "agent",
            answeredTs: "2026-01-01T00:00:00.000Z",
            updatedTs: "2026-01-02T00:00:00.000Z",
        });
        expect(after[0]?.comments?.at(-1)).toContain("nothing sends it again");
        expect(after[3]?.draftOption).toBeUndefined();
        expect(readFileSync(events, "utf8").trim().split("\n")).toHaveLength(2);

        expect(await repairDecisionLog({ file, events, apply: true })).toEqual({ acknowledged: [], reopened: [] });
    });

    test("unstaging a pick leaves the decision open, not an empty drafted row", async () => {
        const { file, events } = scratch();
        await postDecisions(file, events, { sessionId: "abc", decisions: [{ prompt: "one", options: ["a", "b"] }] });
        await updateDecision(file, events, "d_1_abc", { state: "drafted", draftOption: "a" });

        const row = await updateDecision(file, events, "d_1_abc", { draft: "", draftOption: "" });

        expect(row.state).toBe("open");
        expect(row.draftOption).toBeUndefined();
        expect(row.draft).toBeUndefined();
    });
});

describe("chat answers read from where the last read stopped", () => {
    test("a decision asked before the read counts every user entry, also in history without timestamps", () => {
        const entries = [{ line: -2, role: "user" as const, text: "D3 b) keep the old one", paths: [], commits: [] }];
        const decision = { number: 3, letters: ["a", "b"] };

        // Without the hint, timestamp-free history needs the ask among the entries.
        expect(chatAnswers(entries, [decision]).unambiguous).toEqual([]);
        expect(chatAnswers(entries, [{ ...decision, askedBefore: true }]).unambiguous).toMatchObject([
            { number: 3, option: "b", answer: "keep the old one" },
        ]);
        // A revised decision too: it was open, as revised, when the last read ended.
        expect(chatAnswers(entries, [{ ...decision, revision: 2, askedBefore: true }]).unambiguous).toHaveLength(1);
    });

    test("the backfill reads the whole transcript back to the oldest open ask, reports first, then records", async () => {
        const { file, events } = scratch();
        const [row] = await postDecisions(file, events, {
            sessionId: "abc",
            decisions: [{ prompt: "Keep it?", options: ["yes", "no"] }],
        });
        const later = new Date(Date.parse(row.createdTs ?? "") + 60_000).toISOString();
        const reads: { maxBytes?: number; transcriptPath: string }[] = [];
        const read = async (options: { maxBytes?: number; transcriptPath: string }) => {
            reads.push({ maxBytes: options.maxBytes, transcriptPath: options.transcriptPath });
            return {
                found: true,
                issues: [],
                entries: [{ line: -1, role: "user" as const, text: "D1 b)", paths: [], commits: [], timestamp: later }],
            };
        };
        const transcript = { kind: "claude", path: "/fixture/abc.jsonl" };

        const dry = await backfillChatAnswers({ session: "abc", file, events, apply: false, transcript, read });
        expect(dry).toMatchObject({ open: [1], recorded: [], unambiguous: [{ number: 1, option: "b" }] });
        expect(readDecisions(file)[0]?.state).toBe("open");
        expect(reads[0]).toEqual({ maxBytes: Number.POSITIVE_INFINITY, transcriptPath: "/fixture/abc.jsonl" });

        const applied = await backfillChatAnswers({ session: "abc", file, events, apply: true, transcript, read });
        expect(applied.recorded).toEqual([row.id]);
        expect(readDecisions(file)[0]).toMatchObject({
            state: "acknowledged",
            option: "b",
            answeredVia: "automatic_heuristic",
        });
        // Nothing open any more: a second run reads nothing.
        expect(
            (await backfillChatAnswers({ session: "abc", file, events, apply: true, transcript, read })).open
        ).toEqual([]);
        expect(reads).toHaveLength(2);
    });
});

describe("a revision and a staged pick (F12)", () => {
    test("a supersede keeps the staged pick in the old version and says on the row that it was cleared", async () => {
        const { file, events } = scratch();
        const [row] = await postDecisions(file, events, {
            sessionId: "abc",
            decisions: [{ prompt: "Keep it?", options: ["yes", "no"] }],
        });
        await updateDecision(file, events, row.id, { state: "drafted", draftOption: "b", draft: "for now" });
        const [revised] = await postDecisions(file, events, {
            sessionId: "abc",
            decisions: [{ prompt: "Keep it, as is?", options: ["yes", "no"], supersedes: row.id }],
        });

        expect(revised).toMatchObject({ id: row.id, state: "open", revision: 2 });
        expect(revised.draftOption).toBeUndefined();
        expect(revised.versions?.[0]).toMatchObject({ revision: 1, draftOption: "b", draft: "for now" });
        expect(revised.comments?.at(-1)).toContain("the staged b) and note on the earlier text was cleared");
        // A pick made on the old text is refused in words a surface shows.
        await expect(
            updateDecision(file, events, row.id, { state: "drafted", draftOption: "a", expectedRevision: 1 })
        ).rejects.toThrow("DECISION 1 changed: the agent posted a new text since you read it.");
    });
});

describe("decision banners (F13)", () => {
    test("a write that moves a decision out of waiting retracts its banner; a write that keeps it waiting does not", async () => {
        const { file, events } = scratch();
        const removed: string[][] = [];
        setDecisionBannerRemover(async (ids) => {
            removed.push(ids);
        });

        try {
            const [first, second] = await postDecisions(file, events, {
                sessionId: "abc",
                decisions: [
                    { prompt: "one", options: ["a", "b"] },
                    { prompt: "two", options: ["a", "b"] },
                ],
            });
            await updateDecision(file, events, first.id, { state: "drafted", draftOption: "a" });
            await updateDecision(file, events, second.id, { comment: "looked at it" });
            expect(removed).toEqual([]);

            await updateDecisions(
                file,
                events,
                { updates: [{ id: first.id, state: "answered", option: "b" }] },
                undefined,
                { actor: "agent" }
            );
            expect(removed).toEqual([[`qa-decision-${first.id}`]]);
        } finally {
            setDecisionBannerRemover(undefined);
        }
    });
});

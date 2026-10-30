import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TurnSnapshot } from "@genesiscz/utils/ai/transcripts/turn-state";
import { SafeJSON } from "@genesiscz/utils/json";
import { dialogFromRecords, dialogFromSnapshot, dialogRefusal, openDialogFor } from "./guard";
import { DIALOG_KEY_MAPS, optionIndexOf, planDialogKeys } from "./keys";
import { closeQuestion, dialogsPath, openQuestions, readSessionQuestions, upsertQuestion } from "./store";
import { type OpenQuestion, openQuestionKey } from "./types";
import { DialogWatcher, questionFromSnapshot, syncSessionDialogs } from "./watcher";

const SESSION = "fixture-session-1";

function root(): string {
    return mkdtempSync(join(tmpdir(), "agents-dialogs-"));
}

function question(overrides: Partial<OpenQuestion> = {}): OpenQuestion {
    return {
        provider: "claude",
        sessionId: SESSION,
        toolCallId: "toolu_ask_1",
        kind: "decision",
        question: "Ship it?",
        options: ["yes", "no"],
        askedAt: "2026-10-30T10:00:00.000Z",
        source: "hook",
        ...overrides,
    };
}

function snapshot(overrides: Partial<TurnSnapshot>): TurnSnapshot {
    return {
        state: "AWAITING-INPUT",
        lastText: "",
        asksQuestion: false,
        question: null,
        interrupted: false,
        turnError: null,
        lastEventAt: null,
        turnStartedAt: null,
        lastActivityAt: 0,
        silenceMs: 0,
        openTools: [],
        handedBackAt: null,
        ...overrides,
    };
}

describe("dialog record store", () => {
    test("one key is one record: an upsert of the same provider:session:toolCall updates it in place", () => {
        const dir = root();
        upsertQuestion(question({ source: "watcher" }), dir);
        upsertQuestion(question({ question: "Ship it now?", source: "hook" }), dir);

        const stored = readSessionQuestions("claude", SESSION, dir);
        expect(stored).toHaveLength(1);
        expect(stored[0]).toMatchObject({ question: "Ship it now?", source: "hook" });
        expect(openQuestionKey(stored[0])).toBe(`claude:${SESSION}:toolu_ask_1`);
        expect(existsSync(dialogsPath("claude", SESSION, dir))).toBe(true);
        expect(readSessionQuestions("codex", SESSION, dir)).toEqual([]);
    });

    test("an upsert without closedAt keeps a close that already landed, so a late hook does not reopen it", () => {
        const dir = root();
        upsertQuestion(question(), dir);
        closeQuestion(question(), "2026-10-30T10:01:00.000Z", dir);
        upsertQuestion(question({ source: "watcher" }), dir);

        expect(openQuestions("claude", SESSION, dir)).toEqual([]);
        expect(readSessionQuestions("claude", SESSION, dir)[0]?.closedAt).toBe("2026-10-30T10:01:00.000Z");
    });

    test("closing an unknown key is a no-op that writes nothing", () => {
        const dir = root();
        expect(closeQuestion(question({ toolCallId: "never-asked" }), undefined, dir)).toBeNull();
        expect(existsSync(dialogsPath("claude", SESSION, dir))).toBe(false);

        upsertQuestion(question(), dir);
        const before = readFileSync(dialogsPath("claude", SESSION, dir), "utf8");
        expect(closeQuestion(question({ toolCallId: "never-asked" }), undefined, dir)).toBeNull();
        expect(readFileSync(dialogsPath("claude", SESSION, dir), "utf8")).toBe(before);
    });

    test("openQuestions lists the unanswered ones newest first", () => {
        const dir = root();
        upsertQuestion(question({ toolCallId: "old", askedAt: "2026-10-30T09:00:00.000Z" }), dir);
        upsertQuestion(question({ toolCallId: "new", askedAt: "2026-10-30T11:00:00.000Z" }), dir);
        upsertQuestion(question({ toolCallId: "mid", askedAt: "2026-10-30T10:00:00.000Z" }), dir);
        closeQuestion(question({ toolCallId: "mid" }), "2026-10-30T10:05:00.000Z", dir);

        expect(openQuestions("claude", SESSION, dir).map((item) => item.toolCallId)).toEqual(["new", "old"]);
    });

    test("an unreadable file reads as empty, a malformed row is dropped, and an unsafe session id is refused", () => {
        const dir = root();
        upsertQuestion(question(), dir);
        const path = dialogsPath("claude", SESSION, dir);
        writeFileSync(path, SafeJSON.stringify([question({ toolCallId: "kept" }), { provider: "claude" }]));
        expect(readSessionQuestions("claude", SESSION, dir).map((item) => item.toolCallId)).toEqual(["kept"]);

        writeFileSync(path, "{ not json");
        expect(readSessionQuestions("claude", SESSION, dir)).toEqual([]);
        expect(() => dialogsPath("claude", "../escape", dir)).toThrow("a session id is");
    });
});

describe("dialog guard", () => {
    test("dialogFromRecords takes the first open record and skips closed ones", () => {
        const closed = question({ toolCallId: "closed", closedAt: "2026-10-30T10:01:00.000Z" });
        const open = question({ toolCallId: "perm", kind: "permission", question: "Run rm?", options: undefined });

        expect(dialogFromRecords([closed, open])).toEqual({
            kind: "permission",
            question: "Run rm?",
            toolCallId: "perm",
            signal: "hook",
        });
        expect(dialogFromRecords([closed])).toBeNull();
        expect(dialogFromRecords([])).toBeNull();
    });

    test("dialogFromSnapshot answers only when the turn waits on a question tool", () => {
        expect(dialogFromSnapshot(snapshot({ asksQuestion: true, question: "Which branch?" }))).toEqual({
            kind: "decision",
            question: "Which branch?",
            signal: "turn-state",
        });
        // A question asked earlier in a turn that kept running is visible, but nothing waits on it.
        expect(dialogFromSnapshot(snapshot({ asksQuestion: false, question: "Which branch?" }))).toBeNull();
        expect(dialogFromSnapshot(null)).toBeNull();
    });

    test("openDialogFor prefers an open hook record over the transcript, and reads the transcript without one", () => {
        const dir = root();
        const transcript = join(dir, "session.jsonl");
        const at = Date.parse("2026-10-30T10:00:00.000Z");
        const rows = [
            { type: "user", timestamp: new Date(at).toISOString(), message: { role: "user", content: "go" } },
            {
                type: "assistant",
                timestamp: new Date(at + 5_000).toISOString(),
                message: {
                    id: "msg_1",
                    role: "assistant",
                    stop_reason: "tool_use",
                    content: [
                        {
                            type: "tool_use",
                            id: "toolu_q",
                            name: "AskUserQuestion",
                            input: { questions: [{ question: "Pick a colour?" }] },
                        },
                    ],
                },
            },
        ];
        writeFileSync(transcript, `${rows.map((row) => SafeJSON.stringify(row)).join("\n")}\n`);
        const query = { provider: "claude" as const, sessionId: SESSION, recordsRoot: dir, now: at + 10_000 };

        expect(openDialogFor({ ...query, transcriptPath: transcript })).toMatchObject({
            kind: "decision",
            question: "Pick a colour?",
            signal: "turn-state",
        });

        upsertQuestion(question({ kind: "permission", question: "Allow Bash?" }), dir);
        expect(openDialogFor({ ...query, transcriptPath: transcript })).toMatchObject({
            kind: "permission",
            signal: "hook",
        });

        closeQuestion(question(), "2026-10-30T10:00:20.000Z", dir);
        // Without a transcript only the records count, and they are all closed now.
        expect(openDialogFor(query)).toBeNull();
    });

    test("dialogRefusal names the dialog kind and the question, and says how to override", () => {
        const decision = dialogRefusal({ kind: "decision", question: "Ship it?", signal: "turn-state" });
        expect(decision).toStartWith("a question dialog is open in the session (Ship it?)");
        expect(decision).toContain("pass force to type anyway");
        expect(dialogRefusal({ kind: "permission", question: null, signal: "hook" })).toStartWith(
            "a permission prompt is open in the session;"
        );
        expect(dialogRefusal({ kind: "plan", question: "x".repeat(400), signal: "hook" })).toContain(
            `a plan approval is open in the session (${"x".repeat(160)});`
        );
    });
});

describe("the hub-side dialog watcher", () => {
    const at = Date.parse("2026-10-30T10:00:00.000Z");
    const session = { provider: "codex" as const, sessionId: SESSION, transcriptPath: "/unused" };
    const waiting = snapshot({
        asksQuestion: true,
        question: "Which branch?",
        questionCall: { kind: "decision", callId: "call_q1", options: ["main", "dev"] },
        lastEventAt: at,
    });

    test("a question the transcript shows is recorded once, as the watcher's, and closed when it is answered", () => {
        const dir = root();
        const first = syncSessionDialogs(session, { now: at, root: dir, snapshot: waiting });

        expect(first.opened.map(openQuestionKey)).toEqual([`codex:${SESSION}:call_q1`]);
        expect(openQuestions("codex", SESSION, dir)[0]).toMatchObject({
            kind: "decision",
            question: "Which branch?",
            options: ["main", "dev"],
            source: "watcher",
        });
        expect(syncSessionDialogs(session, { now: at, root: dir, snapshot: waiting }).opened).toEqual([]);

        const answered = syncSessionDialogs(session, { now: at + 5_000, root: dir, snapshot: snapshot({}) });
        expect(answered.closed).toEqual([`codex:${SESSION}:call_q1`]);
        expect(openQuestions("codex", SESSION, dir)).toEqual([]);
    });

    test("hook and watcher post the same question as one record, and the watcher never closes the hook's", () => {
        const dir = root();
        upsertQuestion(question({ provider: "codex", toolCallId: "call_q1", source: "hook" }), dir);
        upsertQuestion(
            question({ provider: "codex", toolCallId: "permission:x", kind: "permission", source: "hook" }),
            dir
        );

        expect(syncSessionDialogs(session, { now: at, root: dir, snapshot: waiting }).opened).toEqual([]);
        expect(readSessionQuestions("codex", SESSION, dir)).toHaveLength(2);
        expect(syncSessionDialogs(session, { now: at, root: dir, snapshot: snapshot({}) }).closed).toEqual([]);
        expect(openQuestions("codex", SESSION, dir).map((open) => open.source)).toEqual(["hook", "hook"]);
    });

    test("an unreadable transcript changes nothing, and a closed one waits on nobody", () => {
        const dir = root();
        syncSessionDialogs(session, { now: at, root: dir, snapshot: waiting });

        expect(syncSessionDialogs(session, { now: at, root: dir, snapshot: null })).toEqual({ opened: [], closed: [] });
        expect(openQuestions("codex", SESSION, dir)).toHaveLength(1);
        expect(questionFromSnapshot(session, { ...waiting, state: "FINISHED" }, at)).toBeNull();
    });

    test("a live Grok permission prompt opens a record, an unchanged session is not read again, the answer closes it", () => {
        const dir = root();
        const folder = mkdtempSync(join(tmpdir(), "agents-dialogs-grok-"));
        const updates = join(folder, "updates.jsonl");
        const events = join(folder, "events.jsonl");
        const seconds = Math.floor(at / 1000);
        const line = (value: unknown) => `${SafeJSON.stringify(value)}\n`;
        const update = (sec: number, body: Record<string, unknown>) =>
            line({ timestamp: seconds + sec, method: "_x.ai/session/update", params: { update: body } });
        const call = {
            toolCallId: "call-g1",
            rawInput: { command: "git push", description: "Push the branch" },
            _meta: { "x.ai/tool": { name: "run_terminal_command", kind: "execute" } },
        };

        writeFileSync(
            updates,
            update(0, { sessionUpdate: "user_message_chunk", content: { type: "text", text: "go" } }) +
                update(1, { sessionUpdate: "tool_call", ...call })
        );
        writeFileSync(
            events,
            line({
                ts: new Date(at + 1_200).toISOString(),
                type: "permission_requested",
                tool_name: "run_terminal_command",
            })
        );
        const grok = { provider: "grok" as const, sessionId: "grok-fixture-1", transcriptPath: updates };
        const watcher = new DialogWatcher();

        expect(watcher.sync([grok], { now: at + 30_000, root: dir }).opened).toMatchObject([
            { kind: "permission", toolCallId: "call-g1", question: "run_terminal_command: Push the branch" },
        ]);
        // Nothing changed on disk: the record stays, and nothing is read again.
        writeFileSync(join(dir, "grok", "grok-fixture-1.json"), "[]");
        expect(watcher.sync([grok], { now: at + 31_000, root: dir })).toEqual({ opened: [], closed: [] });
        expect(readSessionQuestions("grok", "grok-fixture-1", dir)).toEqual([]);

        upsertQuestion({ ...questionFromSnapshotFixture(), sessionId: "grok-fixture-1" }, dir);
        appendFileSync(
            events,
            line({
                ts: new Date(at + 40_000).toISOString(),
                type: "permission_resolved",
                tool_name: "run_terminal_command",
                decision: "allow",
                wait_ms: 38_800,
            })
        );
        appendFileSync(updates, update(41, { sessionUpdate: "tool_call_update", status: "completed", ...call }));

        expect(watcher.sync([grok], { now: at + 45_000, root: dir }).closed).toEqual(["grok:grok-fixture-1:call-g1"]);
    });
});

/** The watcher record the Grok test puts back after it emptied the file, to see the answer close it. */
function questionFromSnapshotFixture(): OpenQuestion {
    return question({
        provider: "grok",
        toolCallId: "call-g1",
        kind: "permission",
        question: "run_terminal_command: Push the branch",
        source: "watcher",
    });
}

describe("dialog option keys", () => {
    test("a Claude option is its digit, typed as text, for a letter or a 1-based position", () => {
        const asked = question({ options: ["Red", "Green", "Blue"], questionCount: 1 });

        expect(planDialogKeys(asked, "b")).toEqual({ ok: true, presses: [{ text: "2" }], index: 1, label: "Green" });
        expect(planDialogKeys(asked, "C)")).toMatchObject({ ok: true, presses: [{ text: "3" }], label: "Blue" });
        expect(planDialogKeys(asked, "1")).toMatchObject({ ok: true, presses: [{ text: "1" }], label: "Red" });
        expect(optionIndexOf("bb")).toBeNull();
    });

    test("an option past the list refuses and names the valid letters", () => {
        const plan = planDialogKeys(question({ options: ["Red", "Green", "Blue"] }), "d");

        expect(plan).toEqual({
            ok: false,
            reason: 'option "d" is not in the dialog; its options are a) Red, b) Green, c) Blue',
        });
    });

    test("a dialog without options, with several questions, or of a harness without measured keys refuses", () => {
        expect(planDialogKeys(question({ kind: "plan", options: undefined }), "a")).toMatchObject({ ok: false });
        expect(planDialogKeys(question({ questionCount: 2 }), "a")).toMatchObject({
            ok: false,
            reason: expect.stringContaining("asks 2 questions"),
        });
        expect(planDialogKeys(question({ provider: "codex" }), "a")).toMatchObject({ ok: false });
        expect(planDialogKeys(question({ provider: "grok" }), "a")).toMatchObject({ ok: false });
        expect(Object.keys(DIALOG_KEY_MAPS).sort()).toEqual(["claude", "codex", "grok"]);
    });
});

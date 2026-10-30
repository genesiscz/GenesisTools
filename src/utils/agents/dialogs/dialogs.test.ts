import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TurnSnapshot } from "@genesiscz/utils/ai/transcripts/turn-state";
import { SafeJSON } from "@genesiscz/utils/json";
import { dialogFromRecords, dialogFromSnapshot, dialogRefusal, openDialogFor } from "./guard";
import { closeQuestion, dialogsPath, openQuestions, readSessionQuestions, upsertQuestion } from "./store";
import { type OpenQuestion, openQuestionKey } from "./types";

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

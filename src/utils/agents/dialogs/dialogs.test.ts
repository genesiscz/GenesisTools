import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ACCOUNT_PROVIDER_ALIASES } from "@genesiscz/utils/ai/providers/alias-list";
import type { TurnSnapshot } from "@genesiscz/utils/ai/transcripts/turn-state";
import { SafeJSON } from "@genesiscz/utils/json";
import { dialogFromRecords, dialogFromSnapshot, dialogRefusal, openDialogFor } from "./guard";
import { dialogKeysOf, optionIndexOf, planDialogKeys } from "./keys";
import {
    closeQuestion,
    closeQuestions,
    dialogsPath,
    indexOpenDialogMarkers,
    OPEN_MARKERS_INDEXED,
    openMarkerPath,
    openQuestions,
    readSessionQuestions,
    readSessionQuestionsStrict,
    upsertQuestion,
} from "./store";
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
    test("writers wait for the session lock and preserve concurrent updates", async () => {
        const dir = root();
        const path = dialogsPath("claude", SESSION, dir);
        await upsertQuestion(question(), dir);
        const child = Bun.spawn(
            [
                process.execPath,
                "-e",
                `import { readFileSync, writeFileSync } from "node:fs";
                import { withFileLock } from "./src/utils/storage/file-lock";
                await withFileLock(${SafeJSON.stringify(`${path}.lock`)}, async () => {
                    const records = JSON.parse(readFileSync(${SafeJSON.stringify(path)}, "utf8"));
                    console.log("ready");
                    await Bun.stdin.text();
                    records.push(${SafeJSON.stringify(question({ toolCallId: "child" }))});
                    writeFileSync(${SafeJSON.stringify(path)}, JSON.stringify(records));
                });`,
            ],
            { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: process.env }
        );
        let write: Promise<void> | undefined;
        try {
            const ready = await Promise.race([
                child.stdout.getReader().read(),
                Bun.sleep(5000).then(() => {
                    throw new Error("lock holder did not start");
                }),
            ]);
            expect(new TextDecoder().decode(ready.value)).toContain("ready");
            let completed = false;
            write = Promise.resolve()
                .then(() => upsertQuestion(question({ toolCallId: "parent" }), dir))
                .then(() => {
                    completed = true;
                });
            await Bun.sleep(150);
            expect(completed).toBe(false);
        } finally {
            child.stdin.end();
            await child.exited;
        }
        await write;
        await Promise.all([
            Promise.resolve().then(() => closeQuestion(question(), "2026-10-30T10:01:00.000Z", dir)),
            Promise.resolve().then(() => upsertQuestion(question({ toolCallId: "another" }), dir)),
        ]);
        expect(
            readSessionQuestions("claude", SESSION, dir)
                .map((item) => item.toolCallId)
                .sort()
        ).toEqual(["another", "child", "parent", "toolu_ask_1"]);
        expect(
            readSessionQuestions("claude", SESSION, dir).find((item) => item.toolCallId === "toolu_ask_1")?.closedAt
        ).toBe("2026-10-30T10:01:00.000Z");
    });

    test("a dead writer's stale lock can be recovered without losing records", async () => {
        const dir = root();
        const path = dialogsPath("claude", SESSION, dir);
        await upsertQuestion(question(), dir);
        const child = Bun.spawn(
            [
                process.execPath,
                "-e",
                `import { withFileLock } from "./src/utils/storage/file-lock";
                await withFileLock(${SafeJSON.stringify(`${path}.lock`)}, async () => {
                    console.log("ready");
                    await Bun.stdin.text();
                });`,
            ],
            { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: process.env }
        );
        try {
            const ready = await Promise.race([
                child.stdout.getReader().read(),
                Bun.sleep(5000).then(() => {
                    throw new Error("lock holder did not start");
                }),
            ]);
            expect(new TextDecoder().decode(ready.value)).toContain("ready");
        } finally {
            child.kill("SIGKILL");
            await child.exited;
        }
        await upsertQuestion(question({ toolCallId: "after-crash" }), dir);
        expect(
            readSessionQuestions("claude", SESSION, dir)
                .map((item) => item.toolCallId)
                .sort()
        ).toEqual(["after-crash", "toolu_ask_1"]);
    });

    test("a stale watcher cannot replace or close a hook record", async () => {
        const dir = root();
        await upsertQuestion(question({ source: "watcher" }), dir);
        await upsertQuestion(question({ source: "hook", question: "New hook question" }), dir);
        await upsertQuestion(question({ source: "watcher" }), dir);
        expect(await closeQuestion(question(), "2026-10-30T10:01:00.000Z", dir, "watcher")).toBeNull();
        expect(openQuestions("claude", SESSION, dir)[0]).toMatchObject({
            source: "hook",
            question: "New hook question",
        });
    });

    test("one key is one record: an upsert of the same provider:session:toolCall updates it in place", async () => {
        const dir = root();
        await upsertQuestion(question({ source: "watcher" }), dir);
        await upsertQuestion(question({ question: "Ship it now?", source: "hook" }), dir);

        const stored = readSessionQuestions("claude", SESSION, dir);
        expect(stored).toHaveLength(1);
        expect(stored[0]).toMatchObject({ question: "Ship it now?", source: "hook" });
        expect(openQuestionKey(stored[0])).toBe(`claude:${SESSION}:toolu_ask_1`);
        expect(existsSync(dialogsPath("claude", SESSION, dir))).toBe(true);
        expect(readSessionQuestions("codex", SESSION, dir)).toEqual([]);
    });

    test("an upsert without closedAt keeps a close that already landed, so a late hook does not reopen it", async () => {
        const dir = root();
        await upsertQuestion(question(), dir);
        await closeQuestion(question(), "2026-10-30T10:01:00.000Z", dir);
        await upsertQuestion(question({ source: "watcher" }), dir);

        expect(openQuestions("claude", SESSION, dir)).toEqual([]);
        expect(readSessionQuestions("claude", SESSION, dir)[0]?.closedAt).toBe("2026-10-30T10:01:00.000Z");
    });

    test("closing an unknown key is a no-op that writes nothing", async () => {
        const dir = root();
        expect(await closeQuestion(question({ toolCallId: "never-asked" }), undefined, dir)).toBeNull();
        expect(existsSync(dialogsPath("claude", SESSION, dir))).toBe(false);

        await upsertQuestion(question(), dir);
        const before = readFileSync(dialogsPath("claude", SESSION, dir), "utf8");
        expect(await closeQuestion(question({ toolCallId: "never-asked" }), undefined, dir)).toBeNull();
        expect(readFileSync(dialogsPath("claude", SESSION, dir), "utf8")).toBe(before);
    });

    test("openQuestions lists the unanswered ones newest first", async () => {
        const dir = root();
        await upsertQuestion(question({ toolCallId: "old", askedAt: "2026-10-30T09:00:00.000Z" }), dir);
        await upsertQuestion(question({ toolCallId: "new", askedAt: "2026-10-30T11:00:00.000Z" }), dir);
        await upsertQuestion(question({ toolCallId: "mid", askedAt: "2026-10-30T10:00:00.000Z" }), dir);
        await closeQuestion(question({ toolCallId: "mid" }), "2026-10-30T10:05:00.000Z", dir);

        expect(openQuestions("claude", SESSION, dir).map((item) => item.toolCallId)).toEqual(["new", "old"]);
    });

    test("an unreadable file reads as empty, a malformed row is dropped, and an unsafe session id is refused", async () => {
        const dir = root();
        await upsertQuestion(question(), dir);
        const path = dialogsPath("claude", SESSION, dir);
        const mixed = SafeJSON.stringify([question({ toolCallId: "kept" }), { provider: "claude" }]);
        writeFileSync(path, mixed);
        expect(readSessionQuestions("claude", SESSION, dir).map((item) => item.toolCallId)).toEqual(["kept"]);
        await expect(upsertQuestion(question(), dir)).rejects.toThrow("malformed dialog records");
        expect(readFileSync(path, "utf8")).toBe(mixed);

        writeFileSync(path, "{ not json");
        expect(readSessionQuestions("claude", SESSION, dir)).toEqual([]);
        await expect(upsertQuestion(question(), dir)).rejects.toThrow();
        expect(readFileSync(path, "utf8")).toBe("{ not json");
        expect(() => dialogsPath("claude", "../escape", dir)).toThrow("a session id is");
    });

    test("a record with a damaged optional field is malformed, never closed or crashing", async () => {
        const dir = root();
        await upsertQuestion(question(), dir);
        const path = dialogsPath("claude", SESSION, dir);

        for (const damaged of [
            { closedAt: null },
            { options: "yes" },
            { options: ["yes", 2] },
            { kind: "other" },
            { source: "elsewhere" },
        ]) {
            writeFileSync(path, SafeJSON.stringify([{ ...question({ toolCallId: "kept" }), ...damaged }]));
            expect(readSessionQuestions("claude", SESSION, dir)).toEqual([]);
            expect(() => readSessionQuestionsStrict("claude", SESSION, dir)).toThrow("malformed dialog records");
        }
    });
});

describe("closeQuestions", () => {
    test("closes every picked record in one write and leaves the file alone when it picks none", async () => {
        const dir = root();
        await upsertQuestion(question({ toolCallId: "a", kind: "permission" }), dir);
        await upsertQuestion(question({ toolCallId: "b" }), dir);
        await upsertQuestion(question({ toolCallId: "c", kind: "permission" }), dir);

        const closed = await closeQuestions({
            provider: "claude",
            sessionId: SESSION,
            closedAt: "2026-10-30T10:05:00.000Z",
            root: dir,
            which: (record) => record.kind === "permission",
        });

        expect(closed.map((record) => record.toolCallId)).toEqual(["a", "c"]);
        expect(openQuestions("claude", SESSION, dir).map((record) => record.toolCallId)).toEqual(["b"]);

        const path = dialogsPath("claude", SESSION, dir);
        const before = readFileSync(path, "utf8");
        expect(await closeQuestions({ provider: "claude", sessionId: SESSION, root: dir, which: () => false })).toEqual(
            []
        );
        expect(readFileSync(path, "utf8")).toBe(before);
    });
});

describe("open markers", () => {
    test("a record file from before the markers gets its marker from the one-time pass, and a close removes it", async () => {
        const dir = root();
        const path = dialogsPath("claude", SESSION, dir);
        const done = dialogsPath("claude", "fixture-session-2", dir);
        mkdirSync(dirname(path), { recursive: true });
        // Written by the store as it was before the markers: an open and an answered session, no marker, no flag.
        writeFileSync(path, SafeJSON.stringify([question({ toolCallId: "old-open" })]));
        writeFileSync(
            done,
            SafeJSON.stringify([question({ sessionId: "fixture-session-2", closedAt: "2026-10-30T10:01:00.000Z" })])
        );
        writeFileSync(join(dirname(path), "torn.json"), "[{");

        expect(indexOpenDialogMarkers(dir)).toEqual({ indexed: 2 });
        expect(existsSync(openMarkerPath(path))).toBe(true);
        expect(existsSync(openMarkerPath(done))).toBe(false);
        expect(existsSync(join(dir, OPEN_MARKERS_INDEXED))).toBe(true);
        expect(indexOpenDialogMarkers(dir)).toEqual({ indexed: 0 });

        await closeQuestion(question({ toolCallId: "old-open" }), "2026-10-30T10:05:00.000Z", dir);
        expect(existsSync(openMarkerPath(path))).toBe(false);

        await upsertQuestion(question({ toolCallId: "new-open" }), dir);
        expect(existsSync(openMarkerPath(path))).toBe(true);
    });
});

describe("dialog records across processes", () => {
    test("the hook, the watcher and cmux send writing one session at once lose no record and no close", async () => {
        const dir = root();
        const worker = join(import.meta.dir, "store.test-worker.ts");
        const startAt = String(Date.now() + 1000);
        const children = ["hook", "watcher", "send"].map((prefix) =>
            Bun.spawn([process.execPath, worker, dir, SESSION, prefix, "8", startAt], {
                stdout: "pipe",
                stderr: "pipe",
                env: { ...process.env },
            })
        );

        for (const child of children) {
            const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
            expect({ code, stderr: code === 0 ? "" : stderr }).toEqual({ code: 0, stderr: "" });
        }

        const records = readSessionQuestionsStrict("claude", SESSION, dir);
        expect(records).toHaveLength(24);
        expect(records.filter((record) => record.closedAt !== undefined)).toHaveLength(12);
        expect(
            openQuestions("claude", SESSION, dir)
                .map((record) => record.toolCallId.split("-")[1])
                .sort()
        ).toEqual(["1", "1", "1", "3", "3", "3", "5", "5", "5", "7", "7", "7"]);
    }, 30_000);
});

describe("dialog guard", () => {
    test("an unreadable dialog record blocks typed delivery", () => {
        const dir = root();
        const path = dialogsPath("claude", SESSION, dir);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, "{ not json");
        const blocked = openDialogFor({ provider: "claude", sessionId: SESSION, recordsRoot: dir });
        expect(blocked?.signal).toBe("unreadable");
        expect(
            openDialogFor({ provider: "claude", sessionId: SESSION, recordsRoot: dir, sessionAlive: false })?.signal
        ).toBe("unreadable");
        expect(blocked && dialogRefusal(blocked)).toContain("could not read");
        expect(openDialogFor({ provider: "codex", sessionId: SESSION, recordsRoot: dir })).toBeNull();
    });

    test("a dead Claude session does not keep an old hook dialog open", async () => {
        const dir = root();
        await upsertQuestion(question(), dir);
        const askedAt = Date.parse("2026-10-30T10:00:00.000Z");
        const query = { provider: "claude" as const, sessionId: SESSION, recordsRoot: dir, now: askedAt + 61_000 };
        expect(openDialogFor({ ...query, sessionAlive: false })).toBeNull();
        expect(openDialogFor({ ...query, sessionAlive: true })?.signal).toBe("hook");
        expect(openDialogFor({ ...query, sessionAlive: null })?.signal).toBe("hook");
        expect(openDialogFor({ ...query, sessionAlive: false, now: askedAt + 10_000 })?.signal).toBe("hook");
    });

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
        expect(
            dialogFromSnapshot(snapshot({ asksQuestion: true, question: "Which branch?", state: "FINISHED" }))
        ).toBeNull();
    });

    test("openDialogFor prefers an open hook record over the transcript, and reads the transcript without one", async () => {
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

        await upsertQuestion(question({ kind: "permission", question: "Allow Bash?" }), dir);
        expect(openDialogFor({ ...query, transcriptPath: transcript })).toMatchObject({
            kind: "permission",
            signal: "hook",
        });

        await closeQuestion(question(), "2026-10-30T10:00:20.000Z", dir);
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

    test("a question the transcript shows is recorded once, as the watcher's, and closed when it is answered", async () => {
        const dir = root();
        const first = await syncSessionDialogs(session, { now: at, root: dir, snapshot: waiting });

        expect(first.opened.map(openQuestionKey)).toEqual([`codex:${SESSION}:call_q1`]);
        expect(openQuestions("codex", SESSION, dir)[0]).toMatchObject({
            kind: "decision",
            question: "Which branch?",
            options: ["main", "dev"],
            source: "watcher",
        });
        expect((await syncSessionDialogs(session, { now: at, root: dir, snapshot: waiting })).opened).toEqual([]);

        const answered = await syncSessionDialogs(session, { now: at + 5_000, root: dir, snapshot: snapshot({}) });
        expect(answered.closed).toEqual([`codex:${SESSION}:call_q1`]);
        expect(openQuestions("codex", SESSION, dir)).toEqual([]);
    });

    test("a transcript watcher retains the number of questions", async () => {
        const dir = root();
        const transcript = join(dir, "session.jsonl");
        const questions = [
            { question: "First?", options: [{ label: "Yes" }, { label: "No" }] },
            { question: "Second?", options: [{ label: "Yes" }, { label: "No" }] },
        ];
        const rows = [
            { type: "user", timestamp: new Date(at).toISOString(), message: { role: "user", content: "go" } },
            {
                type: "assistant",
                timestamp: new Date(at + 5000).toISOString(),
                message: {
                    id: "msg_1",
                    role: "assistant",
                    stop_reason: "tool_use",
                    content: [{ type: "tool_use", id: "toolu_multi", name: "AskUserQuestion", input: { questions } }],
                },
            },
        ];
        writeFileSync(transcript, `${rows.map((row) => SafeJSON.stringify(row)).join("\n")}\n`);
        const watched = { provider: "claude" as const, sessionId: SESSION, transcriptPath: transcript };
        const result = await syncSessionDialogs(watched, { now: at + 10_000, root: dir });
        expect(result.opened[0]).toMatchObject({ questionCount: 2 });
        expect(planDialogKeys(result.opened[0], "a")).toMatchObject({ ok: false });
    });

    test("hook and watcher post the same question as one record, and the watcher never closes the hook's", async () => {
        const dir = root();
        await upsertQuestion(question({ provider: "codex", toolCallId: "call_q1", source: "hook" }), dir);
        await upsertQuestion(
            question({ provider: "codex", toolCallId: "permission:x", kind: "permission", source: "hook" }),
            dir
        );

        expect((await syncSessionDialogs(session, { now: at, root: dir, snapshot: waiting })).opened).toEqual([]);
        expect(readSessionQuestions("codex", SESSION, dir)).toHaveLength(2);
        expect((await syncSessionDialogs(session, { now: at, root: dir, snapshot: snapshot({}) })).closed).toEqual([]);
        expect(openQuestions("codex", SESSION, dir).map((open) => open.source)).toEqual(["hook", "hook"]);
    });

    test("an unreadable transcript changes nothing, and a closed one waits on nobody", async () => {
        const dir = root();
        await syncSessionDialogs(session, { now: at, root: dir, snapshot: waiting });

        expect(await syncSessionDialogs(session, { now: at, root: dir, snapshot: null })).toEqual({
            opened: [],
            closed: [],
        });
        expect(openQuestions("codex", SESSION, dir)).toHaveLength(1);
        expect(questionFromSnapshot(session, { ...waiting, state: "FINISHED" }, at)).toBeNull();
    });

    test("a live Grok permission prompt opens a record, an unchanged session is not read again, the answer closes it", async () => {
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

        expect((await watcher.sync([grok], { now: at + 30_000, root: dir })).opened).toMatchObject([
            { kind: "permission", toolCallId: "call-g1", question: "run_terminal_command: Push the branch" },
        ]);
        // Nothing changed on disk: the record stays, and nothing is read again.
        writeFileSync(join(dir, "grok", "grok-fixture-1.json"), "[]");
        expect(await watcher.sync([grok], { now: at + 31_000, root: dir })).toEqual({ opened: [], closed: [] });
        expect(readSessionQuestions("grok", "grok-fixture-1", dir)).toEqual([]);

        await upsertQuestion({ ...questionFromSnapshotFixture(), sessionId: "grok-fixture-1" }, dir);
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

        expect((await watcher.sync([grok], { now: at + 45_000, root: dir })).closed).toEqual([
            "grok:grok-fixture-1:call-g1",
        ]);
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
        const plan = planDialogKeys(question({ options: ["Red", "Green", "Blue"], questionCount: 1 }), "d");

        expect(plan).toEqual({
            ok: false,
            reason: 'option "d" is not in the dialog; its options are a) Red, b) Green, c) Blue',
        });
    });

    test("a dialog with unknown question count refuses a potentially incomplete answer", () => {
        expect(planDialogKeys(question({ options: ["Yes", "No"], questionCount: undefined }), "a")).toMatchObject({
            ok: false,
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
        expect(ACCOUNT_PROVIDER_ALIASES.map((provider) => dialogKeysOf(provider).supported)).toEqual([
            true,
            false,
            false,
        ]);
    });
});

import { describe, expect, spyOn, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import * as fileLines from "@genesiscz/utils/fs/read-lines";
import { SafeJSON } from "@genesiscz/utils/json";
import { meetingsConfigSchema } from "@genesiscz/utils/meetings/config";
import type { Correction } from "@genesiscz/utils/meetings/corrections";
import {
    type MeetingItem,
    type MeetingRecord,
    MeetingStore,
    meetingRecordSchema,
} from "@genesiscz/utils/meetings/record";
import * as atomicFile from "@genesiscz/utils/storage/atomic-file";
import { Storage } from "@genesiscz/utils/storage/storage";
import { lineEvidence } from "@genesiscz/utils/transcribe/evidence";
import type { SpeakerHint } from "@genesiscz/utils/transcribe/speakers";
import type { TranscriptEntry } from "@genesiscz/utils/transcribe/types";
import { ANSWER_LOG_FILE, readAnswerEvents } from "./answer-log";
import {
    actorOf,
    actorText,
    callerActor,
    DecisionJournal,
    decisionActionSchema,
    decisionReach,
    JOURNAL_FILE,
    journalEntrySchema,
} from "./decision-journal";
import { parsePersonAnswer, personKey, personPresent } from "./listen-answers";
import {
    addQualityQuestions,
    clipProgress,
    qualityLines,
    sampleLines,
    splitVoiceStretch,
    thresholdProbe,
    uncertainSharedCallRanges,
} from "./listen-quality";
import { personStays, rosterPresence } from "./person-stays";
import { reviewRow } from "./review-rows";
import { assignmentReach } from "./speaker-assign";
import { correctTranscript } from "./transcript-corrections";
import { enrolRemoteVoices, scoreRemoteLines } from "./voice-enrolment";

const now = "2026-11-09T18:00:00.000Z";
let stores = 0;

function term(id: string, atSec: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { id, kind: "term", status: "suggested", atSec, heard: "Ada", rules: [], suggestedAt: now, ...extra };
}

function question(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id,
        kind: "question",
        status: "suggested",
        about: "term",
        heard: "Ada",
        fromSec: 50,
        toSec: 54,
        question: `Which word (${id})?`,
        choices: ["ADA", "ADO"],
        decides: [],
        rules: [],
        suggestedAt: now,
        ...extra,
    };
}

/** Two terms heard alike and their two questions: an answer to i3 settles i4. */
const lookAlikes = () => [
    term("i1", 50, { proposed: "ADA" }),
    term("i2", 70, { proposed: "ADA" }),
    question("i3", { decides: ["i1"] }),
    question("i4", { fromSec: 70, toSec: 74, decides: ["i2"] }),
];

async function fixture(items: Record<string, unknown>[], labels: Record<string, string> = {}) {
    stores += 1;
    const store = new MeetingStore(new Storage(`meetings-journal-${process.pid}-${stores}`));
    const meeting = await store.create(
        {
            title: "Harbor sync",
            start: "2026-11-09T17:00:00.000Z",
            createdBy: "new",
            items: items as MeetingItem[],
            speakers: { labels },
        },
        { command: "test", change: "fixture" }
    );
    const ledger: Correction[] = [];
    const journal = new DecisionJournal({
        store,
        listenBelow: 0.6,
        ledger: (lines) => ledger.push(...lines),
        now: () => new Date(now),
    });
    const item = (id: string) => store.read(meeting.id)?.items.find((entry) => entry.id === id);
    const events = () => readAnswerEvents(join(store.folder(meeting.id), ANSWER_LOG_FILE));
    return { store, meeting, journal, ledger, item, events };
}

const person = { kind: "listen" } as const;

describe("decision journal", () => {
    test("reopening different tokens reads the journal once per decision", async () => {
        const ids = ["i1", "i2", "i3"];
        const fx = await fixture(ids.map((id, index) => term(id, 10 + index, { proposed: "ADA" })));
        for (const id of ids) {
            await fx.journal.apply({ meeting: fx.meeting.id, action: { kind: "confirm", items: [id] }, actor: person });
        }
        const reads = spyOn(fileLines, "readLinesSync");
        try {
            await fx.journal.apply({ meeting: fx.meeting.id, action: { kind: "reopen", items: ids }, actor: person });
            expect(reads.mock.calls.filter(([path]) => path === fx.journal.path(fx.meeting.id))).toHaveLength(1);
            expect(new MeetingStore(fx.store.storage).read(fx.meeting.id)!.items.map((item) => item.status)).toEqual([
                "suggested",
                "suggested",
                "suggested",
            ]);
            reads.mockClear();
            await fx.journal.apply({ meeting: fx.meeting.id, action: { kind: "confirm", items: ids }, actor: person });
            await fx.journal.apply({ meeting: fx.meeting.id, action: { kind: "reopen", items: ids }, actor: person });
            expect(reads.mock.calls.filter(([path]) => path === fx.journal.path(fx.meeting.id))).toHaveLength(1);
            expect(
                new MeetingStore(fx.store.storage)
                    .read(fx.meeting.id)!
                    .items.every((item) => item.status === "suggested")
            ).toBe(true);
        } finally {
            reads.mockRestore();
        }
    });

    test("the internal observer receives committed locked snapshots and excludes the next queued write", async () => {
        const fx = await fixture(lookAlikes());
        const snapshots: Array<{ before: MeetingRecord; after: MeetingRecord }> = [];
        const queued: Array<Promise<MeetingRecord>> = [];
        const journal = new DecisionJournal({
            store: fx.store,
            ledger: () => {},
            now: () => new Date(now),
            onApplied: (snapshot) => {
                snapshots.push(snapshot);
                expect(new MeetingStore(fx.store.storage).read(fx.meeting.id)).toEqual(snapshot.after);
                queued.push(
                    fx.store.update(fx.meeting.id, { command: "test", change: "concurrent title" }, (record) => {
                        record.title = "Next writer";
                    })
                );
            },
        });
        const request = { meeting: fx.meeting.id, action: { kind: "confirm", items: ["i1"] } as const, actor: person };
        await journal.plan({ ...request, action: { kind: "confirm", items: ["i1"] } });
        expect(snapshots).toHaveLength(0);
        await journal.apply({ ...request, action: { kind: "confirm", items: ["i1"] } });
        await Promise.all(queued);
        expect(snapshots).toHaveLength(1);
        expect(snapshots[0]?.before.items[0]?.status).toBe("suggested");
        expect(snapshots[0]?.after.items[0]?.status).toBe("confirmed");
        expect(snapshots[0]?.after.title).toBe("Harbor sync");
        expect(new MeetingStore(fx.store.storage).read(fx.meeting.id)?.title).toBe("Next writer");
        await journal.apply({ ...request, action: { kind: "confirm", items: ["i1"] } });
        expect(snapshots).toHaveLength(1);
    });

    test('an answer that leaves its look-alikes decides only its own question (the window\'s "Only this question")', async () => {
        const fx = await fixture(lookAlikes());
        const action = { kind: "answer", question: "Q1", answer: "ADO", lookAlikes: "leave" } as const;
        const planned = await fx.journal.plan({ meeting: fx.meeting.id, action, actor: person });

        expect(planned.entry).toMatchObject({ settled: [], decided: ["i1", "i3"] });

        const { entry } = await fx.journal.apply({ meeting: fx.meeting.id, action, actor: person });

        expect(entry).toMatchObject({ question: "i3", settled: [], decided: ["i1", "i3"] });
        expect(fx.item("i1")).toMatchObject({ status: "confirmed", proposed: "ADO" });
        expect(fx.item("i4")).toMatchObject({ status: "suggested" });
        expect(fx.item("i2")).toMatchObject({ status: "suggested", proposed: "ADA" });
    });

    test("an answer and the look-alike it settled are one entry, and its token reverts both", async () => {
        const fx = await fixture(lookAlikes());
        const { entry } = await fx.journal.apply({
            meeting: fx.meeting.id,
            action: { kind: "answer", question: "Q1", answer: "ADO", comment: "heard twice" },
            actor: person,
            reason: "the speaker spelled it",
        });

        expect(entry).toMatchObject({ question: "i3", settled: ["i4"], decided: ["i1", "i2", "i3", "i4"] });
        expect(fx.item("i2")).toMatchObject({
            status: "confirmed",
            proposed: "ADO",
            decision: {
                token: entry?.token,
                actor: person,
                entry: { action: "answer", reason: "the speaker spelled it", question: "i3" },
            },
        });

        const reverted = await fx.journal.revert({ meeting: fx.meeting.id, token: entry!.token, actor: person });

        for (const id of ["i1", "i2", "i3", "i4"]) {
            expect(fx.item(id)).toMatchObject({ status: "suggested" });
            expect(fx.item(id)).not.toHaveProperty("decision");
            expect(fx.item(id)).not.toHaveProperty("decidedAt");
        }

        expect(fx.item("i1")).toMatchObject({ proposed: "ADA" });
        expect(fx.item("i3")).not.toHaveProperty("answer");
        expect(reverted.entry?.action).toEqual({ kind: "revert", token: entry!.token });
        expect(fx.events().map((event) => event.event)).toEqual(["answered", "reopened"]);
        expect(fx.events()[1]).toMatchObject({ item: "i3", also: ["i4"] });
        // Each confirmation, then its withdrawal: dictionary suggest reads the pair as no evidence.
        expect(fx.ledger.map((line) => [line.item, line.fixed, line.retracted === true])).toEqual([
            ["i1", "ADO", false],
            ["i2", "ADO", false],
            ["i1", "ADO", true],
            ["i2", "ADO", true],
        ]);
    });

    test("a later decision on one of its items refuses the revert, and nothing is undone", async () => {
        const fx = await fixture(lookAlikes());
        const { entry } = await fx.journal.apply({
            meeting: fx.meeting.id,
            action: { kind: "answer", question: "i3", answer: "ADO" },
            actor: person,
        });
        await fx.journal.apply({
            meeting: fx.meeting.id,
            action: { kind: "reject", items: ["i2"] },
            actor: { kind: "cli" },
        });

        await expect(
            fx.journal.revert({ meeting: fx.meeting.id, token: entry!.token, actor: person })
        ).rejects.toMatchObject({ code: "item-changed" });
        expect(fx.item("i3")).toMatchObject({ status: "confirmed", answer: "ADO" });
        expect(fx.item("i2")).toMatchObject({ status: "rejected" });
    });

    test("plan answers the entry an apply would make and writes nothing", async () => {
        const fx = await fixture(lookAlikes());
        const recordPath = fx.store.path(fx.meeting.id);
        const bytes = readFileSync(recordPath, "utf8");
        const planned = await fx.journal.plan({
            meeting: fx.meeting.id,
            action: { kind: "answer", question: "i3", answer: "ADO" },
            actor: { kind: "window" },
        });

        expect(planned.entry).toMatchObject({ settled: ["i4"], decided: ["i1", "i2", "i3", "i4"] });
        expect(readFileSync(recordPath, "utf8")).toBe(bytes);
        expect(existsSync(join(fx.store.folder(fx.meeting.id), JOURNAL_FILE))).toBe(false);
        expect(fx.events()).toEqual([]);
        expect(fx.ledger).toEqual([]);
    });

    test("an agent caller is recorded with its harness and session, and a person at a command as cli", async () => {
        const agent = callerActor({ agent: "codex", sessionId: "1234abcd-5678", isInAgent: true });
        expect(agent).toEqual({ kind: "agent", harness: "codex", session: "1234abcd-5678" });
        expect(callerActor({ agent: "unknown", sessionId: null, isInAgent: false })).toEqual({ kind: "cli" });

        const fx = await fixture([term("i1", 10, { proposed: "wiki" })]);
        const { entry } = await fx.journal.apply({
            meeting: fx.meeting.id,
            action: { kind: "confirm", items: ["i1"] },
            actor: agent,
            reason: "the dictionary has it",
        });

        expect(fx.item("i1")?.decision?.actor).toEqual(agent);
        expect(fx.journal.read(fx.meeting.id)).toEqual([
            expect.objectContaining({ token: entry?.token, actor: agent }),
        ]);
        expect(actorText(agent)).toBe("an agent (Codex, session 1234abcd)");
        expect(actorText({ kind: "window" })).toBe("you");
        expect(actorText({ kind: "listen" })).toBe("you in the terminal");
        expect(actorText({ kind: "agent", harness: "claude-code", session: null })).toBe("an agent (Claude Code)");
        expect(actorText({ kind: "agent", harness: "grok", session: null })).toBe("an agent (Grok)");
        expect(actorText({ kind: "agent", harness: "other-agent", session: null })).toBe("an agent (other-agent)");
        expect(actorText({ kind: "unknown" })).toBe("someone, before the history existed");
    });

    test("a future journal action remains visible, cannot be undone, and does not block known decisions", async () => {
        const fx = await fixture([term("i1", 10, { proposed: "Wiki" })]);
        const result = await fx.journal.apply({
            meeting: fx.meeting.id,
            action: { kind: "confirm", items: ["i1"] },
            actor: person,
        });
        const file = fx.journal.path(fx.meeting.id);
        appendFileSync(
            file,
            `${SafeJSON.stringify({
                token: "future-token",
                at: now,
                meeting: fx.meeting.id,
                actor: { kind: "window" },
                action: { kind: "future-action", extra: { version: 9 } },
                changes: [],
            })}\n`
        );
        const bytes = readFileSync(file, "utf8");
        const record = readFileSync(fx.store.path(fx.meeting.id), "utf8");
        const entries = fx.journal.read(fx.meeting.id);
        expect(entries).toHaveLength(2);
        expect(entries[0]?.action).toEqual({ kind: "unsupported", name: "future-action" });
        expect(journalEntrySchema.parse(entries[0]).action).toEqual(entries[0]?.action);
        expect(decisionActionSchema.safeParse({ kind: "unsupported", name: "future-action" }).success).toBe(false);
        expect(journalEntrySchema.safeParse({ ...entries[0], action: { kind: "answer" } }).success).toBe(false);
        await expect(
            fx.journal.revert({ meeting: fx.meeting.id, token: "future-token", actor: person })
        ).rejects.toThrow("newer build");
        expect(readFileSync(file, "utf8")).toBe(bytes);
        expect(readFileSync(fx.store.path(fx.meeting.id), "utf8")).toBe(record);
        await fx.journal.revert({ meeting: fx.meeting.id, token: result.entry!.token, actor: person });
        expect(fx.item("i1")?.status).toBe("suggested");
        expect(readFileSync(file, "utf8").startsWith(bytes)).toBe(true);
    });

    test("an item decided before the journal reads as unknown, and its old token still reopens it", async () => {
        const fx = await fixture([
            term("i1", 10, {
                status: "confirmed",
                proposed: "Wiki",
                decidedAt: now,
                decision: { token: "older-token", previous: { status: "suggested", proposed: "wiki" } },
            }),
        ]);
        const legacy = fx.item("i1")!;

        expect(actorOf(legacy)).toEqual({ kind: "unknown" });

        const { entry } = await fx.journal.revert({
            meeting: fx.meeting.id,
            token: "older-token",
            items: ["i1"],
            actor: { kind: "window" },
        });

        expect(entry?.changes.map((change) => change.id)).toEqual(["i1"]);
        expect(fx.item("i1")).toMatchObject({ status: "suggested", proposed: "wiki" });
        expect(fx.item("i1")).not.toHaveProperty("decision");
    });

    test("a respelling confirms the item with the new text (R45) and its Undo brings the proposal back", async () => {
        const fx = await fixture([term("i1", 10, { heard: "OMP", proposed: "OMP" })]);
        const { entry } = await fx.journal.apply({
            meeting: fx.meeting.id,
            action: { kind: "respell", item: "i1", text: " EMP " },
            actor: { kind: "window" },
        });

        expect(fx.item("i1")).toMatchObject({ status: "confirmed", proposed: "EMP" });
        expect(fx.item("i1")?.decision?.entry).toEqual({ action: "respell" });
        expect(fx.ledger).toEqual([expect.objectContaining({ heard: "OMP", fixed: "EMP" })]);

        const same = await fx.journal.apply({
            meeting: fx.meeting.id,
            action: { kind: "respell", item: "i1", text: "EMP" },
            actor: { kind: "window" },
        });
        expect(same).toEqual({ skipped: [{ id: "i1", reason: 'it is confirmed as "EMP" already', needs: "nothing" }] });

        await fx.journal.revert({ meeting: fx.meeting.id, token: entry!.token, actor: { kind: "window" } });
        expect(fx.item("i1")).toMatchObject({ status: "suggested", proposed: "OMP" });
    });

    test("confirming a stem term with another spelling moves its replacement stem too", async () => {
        const fx = await fixture([term("i1", 10, { heardStem: "Ada", proposed: "ADA", proposedStem: "ADA" })]);
        await fx.journal.apply({
            meeting: fx.meeting.id,
            action: { kind: "confirm", items: ["i1"], proposed: "ADO" },
            actor: person,
        });

        expect(fx.item("i1")).toMatchObject({ status: "confirmed", proposed: "ADO", proposedStem: "ADO" });
    });

    test("a respelt question names the answer command with the text quoted for the shell", async () => {
        const fx = await fixture([question("i1")]);
        const result = await fx.journal.apply({
            meeting: fx.meeting.id,
            action: { kind: "respell", item: "i1", text: 'Alice "Work" $(id)' },
            actor: { kind: "window" },
        });

        expect(result.skipped?.[0]?.reason).toEndWith(`--answer 'Alice "Work" $(id)'`);
    });

    test("spelling reach survives reopen, changes only selected lines and can decline dictionary teaching", async () => {
        const fx = await fixture([term("i1", 5, { proposed: "ADA" })]);
        const reach = {
            lines: [
                { atSec: 5, line: 0 },
                { atSec: 15, line: 2 },
            ],
            dictionary: false,
        };
        const action = decisionActionSchema.parse({ kind: "confirm", items: ["i1"], reach });
        const decided = await fx.journal.apply({ meeting: fx.meeting.id, action, actor: person });
        const reopened = new MeetingStore(fx.store.storage).read(fx.meeting.id)!;
        const transcript = [5, 10, 15].map((startSec) => ({ startSec, speaker: "Speaker 1", text: "Ada is here" }));
        const corrected = correctTranscript({
            record: reopened,
            transcript,
            config: meetingsConfigSchema.parse({}),
            format: "json",
            dictionary: false,
        });
        expect(corrected.entries.map((line) => line.text)).toEqual(["ADA is here", "Ada is here", "ADA is here"]);
        expect(corrected.outcomes.filter((outcome) => outcome.item === "i1")).toHaveLength(1);
        expect(corrected.outcomes.find((outcome) => outcome.item === "i1")).toMatchObject({
            status: "applied",
            lines: [{ index: 0 }, { index: 2 }],
        });
        expect(reopened.items[0]).toMatchObject({ reach });
        expect(fx.ledger[0]).toMatchObject({ learn: false });
        await fx.journal.revert({ meeting: fx.meeting.id, token: decided.entry!.token, actor: person });
        expect(new MeetingStore(fx.store.storage).read(fx.meeting.id)?.items[0]).not.toHaveProperty("reach");
    });

    test("spelling preview resolves moved line addresses and omits untimed lines", async () => {
        const fx = await fixture([term("i1", 5, { proposed: "ADA" })]);
        const planned = await fx.journal.plan({
            meeting: fx.meeting.id,
            action: { kind: "confirm", items: ["i1"], reach: { lines: [{ atSec: 10, line: 1 }] } },
            actor: person,
        });
        const reach = decisionReach({
            entry: planned.entry!,
            named: ["i1"],
            transcript: [
                { speaker: "Speaker 1", text: "Ada has no timestamp" },
                { startSec: 5, speaker: "Speaker 1", text: "Ada is here" },
                { startSec: 10, speaker: "Speaker 1", text: "Ada is there" },
            ],
            ledger: [],
            repeats: 2,
        });
        expect(reach.spelling?.occurrences.map(({ line, selected }) => ({ line, selected }))).toEqual([
            { line: 1, selected: false },
            { line: 2, selected: true },
        ]);
    });

    test("changing only spelling reach stamps a new decision and permits explicit dictionary teaching", async () => {
        const fx = await fixture([term("i1", 5, { proposed: "ADA" })]);
        const first = await fx.journal.apply({
            meeting: fx.meeting.id,
            action: decisionActionSchema.parse({
                kind: "confirm",
                items: ["i1"],
                reach: { lines: [{ atSec: 5, line: 0 }], dictionary: false },
            }),
            actor: person,
        });
        const nextReach = {
            lines: [
                { atSec: 5, line: 0 },
                { atSec: 10, line: 1 },
            ],
            dictionary: true,
        };
        const second = await fx.journal.apply({
            meeting: fx.meeting.id,
            action: decisionActionSchema.parse({ kind: "respell", item: "i1", text: "ADA", reach: nextReach }),
            actor: person,
        });
        const reopened = new MeetingStore(fx.store.storage).read(fx.meeting.id)!;
        expect(reopened.items[0]).toMatchObject({ reach: nextReach, decision: { token: second.entry!.token } });
        expect(second.entry!.token).not.toBe(first.entry!.token);
        expect(fx.ledger.at(-1)).toMatchObject({ scope: "line", learn: true });
        await fx.journal.revert({ meeting: fx.meeting.id, token: second.entry!.token, actor: person });
        expect(new MeetingStore(fx.store.storage).read(fx.meeting.id)?.items[0]).toMatchObject({
            reach: { lines: [{ atSec: 5, line: 0 }], dictionary: false },
        });
    });

    test("rephrasing a question preserves its answer and targets, survives reopen, and undoes without deciding it", async () => {
        const fx = await fixture(lookAlikes());
        const before = fx.item("i3")!;
        if (before.kind !== "question") {
            throw new Error("fixture must hold a question");
        }
        const action = decisionActionSchema.parse({
            kind: "rephrase",
            question: "Q1",
            text: "Which API was named?",
            expectedText: "Which word (i3)?",
        });
        const edited = await fx.journal.apply({ meeting: fx.meeting.id, action, actor: person });
        expect(edited.entry?.decided).toEqual([]);
        expect(new MeetingStore(fx.store.storage).read(fx.meeting.id)?.items.find((item) => item.id === "i3")).toEqual({
            ...before,
            question: "Which API was named?",
        });
        expect(fx.item("i1")?.status).toBe("suggested");
        await fx.journal.revert({ meeting: fx.meeting.id, token: edited.entry!.token, actor: person });
        expect(fx.item("i3")).toEqual(before);
        expect(fx.events()).toEqual([]);
        expect(fx.ledger).toEqual([]);
    });

    test("rephrasing refuses an outdated draft and undo refuses to overwrite a later wording", async () => {
        const fx = await fixture([question("i1", { status: "confirmed", answer: "ADA" })]);
        const apply = (text: string, expectedText: string) =>
            fx.journal.apply({
                meeting: fx.meeting.id,
                action: decisionActionSchema.parse({ kind: "rephrase", question: "i1", text, expectedText }),
                actor: person,
            });
        const first = await apply("First wording?", "Which word (i1)?");
        await expect(apply("Stale wording?", "Which word (i1)?")).rejects.toMatchObject({ code: "item-changed" });
        await apply("Second wording?", "First wording?");
        await expect(
            fx.journal.revert({ meeting: fx.meeting.id, token: first.entry!.token, actor: person })
        ).rejects.toMatchObject({ code: "item-changed" });
        expect(fx.item("i1")).toMatchObject({ status: "confirmed", answer: "ADA", question: "Second wording?" });
    });

    test("a speaker rename is an entry with the label before and after, and its revert takes the name away", async () => {
        const fx = await fixture([], { S2: "Bob Example" });
        const { entry } = await fx.journal.apply({
            meeting: fx.meeting.id,
            action: { kind: "rename", label: "S1", name: "Dana Example" },
            actor: { kind: "cli" },
        });

        expect(entry?.labels).toEqual([{ label: "S1", after: "Dana Example" }]);
        expect(fx.store.read(fx.meeting.id)?.speakers.labels).toEqual({ S2: "Bob Example", S1: "Dana Example" });

        await fx.journal.revert({ meeting: fx.meeting.id, token: entry!.token, actor: { kind: "cli" } });
        expect(fx.store.read(fx.meeting.id)?.speakers.labels).toEqual({ S2: "Bob Example" });
    });

    test("read lists newest first, keeps only an item's entries, and names the revert that undid an entry", async () => {
        const fx = await fixture([term("i1", 10, { proposed: "wiki" }), term("i2", 20, { proposed: "jira" })]);
        const first = await fx.journal.apply({
            meeting: fx.meeting.id,
            action: { kind: "confirm", items: ["i1"] },
            actor: { kind: "cli" },
        });
        const second = await fx.journal.apply({
            meeting: fx.meeting.id,
            action: { kind: "reject", items: ["i2"] },
            actor: { kind: "cli" },
        });
        const undo = await fx.journal.revert({ meeting: fx.meeting.id, token: first.entry!.token, actor: person });

        const tokens = (entries: Array<{ token: string }>): Array<string | undefined> =>
            entries.map((entry) => entry.token);

        expect(tokens(fx.journal.read(fx.meeting.id))).toEqual([
            undo.entry?.token,
            second.entry?.token,
            first.entry?.token,
        ]);
        expect(tokens(fx.journal.read(fx.meeting.id, { item: "i2" }))).toEqual([second.entry?.token]);
        expect(fx.journal.read(fx.meeting.id, { item: "i1" })[1]).toMatchObject({ revertedBy: undo.entry?.token });
        expect(fx.journal.read(fx.meeting.id, { limit: 1 })).toHaveLength(1);
    });

    // A torn line (a crash or a full disk during the append, a hand edit) is skipped, so the journal, every Undo by
    // token and the Esc of a listen round still work for the meeting.
    test("a line that is not JSON is skipped: read lists the others and their tokens still revert", async () => {
        const fx = await fixture([term("i1", 10, { proposed: "wiki" }), term("i2", 20, { proposed: "jira" })]);
        const first = await fx.journal.apply({
            meeting: fx.meeting.id,
            action: { kind: "confirm", items: ["i1"] },
            actor: { kind: "cli" },
        });
        appendFileSync(fx.journal.path(fx.meeting.id), '{"token":"torn-line","at":"2026-11-09T18:0\n');
        const second = await fx.journal.apply({
            meeting: fx.meeting.id,
            action: { kind: "confirm", items: ["i2"] },
            actor: { kind: "cli" },
        });

        expect(fx.journal.read(fx.meeting.id).map((entry): string | undefined => entry.token)).toEqual([
            second.entry?.token,
            first.entry?.token,
        ]);
        await fx.journal.revert({ meeting: fx.meeting.id, token: first.entry!.token, actor: person });
        expect(fx.item("i1")).toMatchObject({ status: "suggested" });
        expect(fx.item("i2")).toMatchObject({ status: "confirmed" });
    });

    // A decision is saved only with its journal line: a line that cannot be written leaves the record as it was, so a
    // retry decides it again (and journals it), and its Undo works. Before, the record kept the decision and the retry
    // skipped the item as decided, with no entry to undo.
    test("a journal line that cannot be written leaves the record undecided, so a retry journals it and its Undo works", async () => {
        const fx = await fixture(lookAlikes());
        const answer = { kind: "answer", question: "Q1", answer: "ADO" } as const;
        // A folder where the journal file goes: the append fails as a full disk or a missing permission would.
        mkdirSync(fx.journal.path(fx.meeting.id));

        await expect(fx.journal.apply({ meeting: fx.meeting.id, action: answer, actor: person })).rejects.toThrow();
        for (const id of ["i1", "i2", "i3", "i4"]) {
            expect(fx.item(id)).toMatchObject({ status: "suggested" });
            expect(fx.item(id)).not.toHaveProperty("decision");
        }
        expect(fx.events()).toEqual([]);
        expect(fx.ledger).toEqual([]);

        rmdirSync(fx.journal.path(fx.meeting.id));
        const { entry } = await fx.journal.apply({ meeting: fx.meeting.id, action: answer, actor: person });
        expect(entry?.decided).toEqual(["i1", "i2", "i3", "i4"]);

        await fx.journal.revert({ meeting: fx.meeting.id, token: entry!.token, actor: person });
        expect(fx.item("i3")).toMatchObject({ status: "suggested" });
        expect(fx.events().map((event) => event.event)).toEqual(["answered", "reopened"]);
    });

    test("an answer log line that cannot be written takes the journal line back and saves nothing", async () => {
        const fx = await fixture(lookAlikes());
        mkdirSync(join(fx.store.folder(fx.meeting.id), ANSWER_LOG_FILE));

        await expect(
            fx.journal.apply({
                meeting: fx.meeting.id,
                action: { kind: "answer", question: "Q1", answer: "ADO" },
                actor: person,
            })
        ).rejects.toThrow();
        expect(readFileSync(fx.journal.path(fx.meeting.id), "utf8")).toBe("");
        expect(fx.journal.read(fx.meeting.id)).toEqual([]);
        expect(fx.item("i3")).toMatchObject({ status: "suggested" });
        expect(fx.ledger).toEqual([]);
    });

    test("a record that cannot be saved takes its journal and answer log lines back", async () => {
        const fx = await fixture(lookAlikes());
        const first = await fx.journal.apply({
            meeting: fx.meeting.id,
            action: { kind: "answer", question: "Q1", answer: "ADO" },
            actor: person,
        });
        const journalBefore = readFileSync(fx.journal.path(fx.meeting.id), "utf8");
        const write = spyOn(atomicFile, "atomicWriteFileSync").mockImplementationOnce(() => {
            throw new Error("ENOSPC: no space left on device");
        });

        try {
            await expect(
                fx.journal.revert({ meeting: fx.meeting.id, token: first.entry!.token, actor: person })
            ).rejects.toThrow("ENOSPC");
        } finally {
            write.mockRestore();
        }

        expect(readFileSync(fx.journal.path(fx.meeting.id), "utf8")).toBe(journalBefore);
        expect(fx.events().map((event) => event.event)).toEqual(["answered"]);
        expect(fx.item("i3")).toMatchObject({ status: "confirmed", decision: { token: first.entry!.token } });
        expect(fx.ledger.every((line) => line.retracted !== true)).toBe(true);

        await fx.journal.revert({ meeting: fx.meeting.id, token: first.entry!.token, actor: person });
        expect(fx.item("i3")).toMatchObject({ status: "suggested" });
        expect(fx.events().map((event) => event.event)).toEqual(["answered", "reopened"]);
    });

    // A real tear has no line end: the next entry must start on a line of its own, or it is glued onto the torn bytes
    // and the newest decision is the one that no longer reads.
    test("an entry after a torn last line without a line end still reads, and its token reverts", async () => {
        const fx = await fixture([term("i1", 10, { proposed: "wiki" })]);
        appendFileSync(fx.journal.path(fx.meeting.id), '{"token":"torn-line","at":"2026-11-09T18:0');
        const decided = await fx.journal.apply({
            meeting: fx.meeting.id,
            action: { kind: "confirm", items: ["i1"] },
            actor: { kind: "cli" },
        });

        expect(fx.journal.read(fx.meeting.id).map((entry): string | undefined => entry.token)).toEqual([
            decided.entry?.token,
        ]);
        await fx.journal.revert({ meeting: fx.meeting.id, token: decided.entry!.token, actor: person });
        expect(fx.item("i1")).toMatchObject({ status: "suggested" });
    });

    test("an add is one entry with the items it made, and its Undo removes them unless decided since", async () => {
        const fx = await fixture([term("i1", 10)]);
        const finding = {
            kind: "term" as const,
            at: 20,
            heard: "harbour",
            proposed: "Harbor",
            confidence: 0.7,
            reason: "the agenda",
        };
        const added = await fx.journal.apply({
            meeting: fx.meeting.id,
            action: { kind: "add", findings: [finding, { ...finding, at: 30 }] },
            actor: { kind: "agent", harness: "codex", session: null },
        });

        expect(added.entry?.changes.map((change) => [change.id, change.before, change.after?.status])).toEqual([
            ["i2", undefined, "suggested"],
            ["i3", undefined, "suggested"],
        ]);
        expect(fx.store.read(fx.meeting.id)?.history.at(-1)).toMatchObject({
            command: "items add",
            change: "2 findings",
        });
        await fx.journal.apply({ meeting: fx.meeting.id, action: { kind: "confirm", items: ["i3"] }, actor: person });
        await expect(
            fx.journal.revert({ meeting: fx.meeting.id, token: added.entry!.token, actor: person })
        ).rejects.toThrow("i3 (confirmed now) was decided again");
        await fx.journal.revert({ meeting: fx.meeting.id, token: added.entry!.token, items: ["i2"], actor: person });
        expect(fx.store.read(fx.meeting.id)?.items.map((item) => item.id)).toEqual(["i1", "i3"]);
    });

    test("a set is one entry with the fields before and after, and its Undo puts them back until changed again", async () => {
        const fx = await fixture([]);
        const set = await fx.journal.apply({
            meeting: fx.meeting.id,
            action: { kind: "set", project: "Harbor", labels: ["Ops"] },
            actor: { kind: "window" },
        });

        expect(set.entry?.fields).toEqual([
            { field: "project", after: "Harbor" },
            { field: "labels", before: [], after: ["Ops"] },
        ]);
        expect(set.entry?.changes).toEqual([]);
        await fx.journal.revert({ meeting: fx.meeting.id, token: set.entry!.token, actor: { kind: "window" } });
        expect(fx.store.read(fx.meeting.id)).toMatchObject({ labels: [] });
        expect(fx.store.read(fx.meeting.id)?.project).toBeUndefined();

        const again = await fx.journal.apply({
            meeting: fx.meeting.id,
            action: { kind: "set", project: "Harbor" },
            actor: { kind: "window" },
        });
        await fx.journal.apply({ meeting: fx.meeting.id, action: { kind: "set", project: "Atlas" }, actor: person });
        await expect(
            fx.journal.revert({ meeting: fx.meeting.id, token: again.entry!.token, actor: { kind: "window" } })
        ).rejects.toThrow(`the project of ${fx.meeting.id} changed again after the decision this Undo names`);
        const same = await fx.journal.apply({
            meeting: fx.meeting.id,
            action: { kind: "set", project: "Atlas" },
            actor: person,
        });
        expect(same).toEqual({ skipped: [] });
    });

    test("with ownRound, an answer made while no listen round runs writes its own round around its line", async () => {
        stores += 1;
        const fx = await fixture(lookAlikes());
        const own = new DecisionJournal({
            store: fx.store,
            listenBelow: 0.6,
            ledger: () => undefined,
            now: () => new Date(now),
            ownRound: true,
        });
        await own.apply({
            meeting: fx.meeting.id,
            action: { kind: "skip", question: "i4" },
            actor: { kind: "window" },
        });

        expect(fx.events().map((event) => event.event)).toEqual(["round-start", "skipped", "round-end"]);
        expect(fx.events()[2]).toMatchObject({ reason: "done", asked: 1, open: 1 });
    });

    test("a plan's reach names the look-alikes an answer settles and the dictionary a spelling teaches", async () => {
        const fx = await fixture(lookAlikes());
        const planned = await fx.journal.plan({
            meeting: fx.meeting.id,
            action: { kind: "answer", question: "i3", answer: "ADO" },
            actor: person,
        });
        const seen = (meeting: string, extra: Partial<Correction> = {}): Correction => ({
            at: now,
            meeting,
            kind: "term",
            scope: "everywhere",
            heard: "Ada",
            fixed: "ADO",
            item: "i9",
            ...extra,
        });
        const reach = decisionReach({
            entry: planned.entry!,
            named: ["i3"],
            transcript: [
                { speaker: "S1", text: "ada said so", startSec: 50 },
                { speaker: "S1", text: "nothing here", startSec: 60 },
            ],
            ledger: [
                seen("2026-11-01_harbor"),
                seen("2026-11-02_retro"),
                seen("2026-11-02_retro", { retracted: true }),
            ],
            repeats: 2,
        });

        // i1 is the question's own target inside the span it asks about: the same question, not a look-alike. i2
        // goes with the look-alike question i4 that decides it.
        expect(reach.items).toEqual([
            { id: "i4", match: "same", role: "look-alike", after: "ADO" },
            { id: "i1", match: "same", role: "same", before: "ADA", after: "ADO" },
        ]);
        expect(reach.lines).toBe(1);
        expect(reach.dictionary).toEqual([
            { heard: "Ada", fixed: "ADO", seenBefore: 1, teaches: true },
            { heard: "Ada", fixed: "ADO", seenBefore: 1, teaches: true },
        ]);
        expect(fx.events()).toEqual([]);
    });
});

describe("speaker assignments (assign)", () => {
    /** Three voices: S1 twice, S2 once, S3 in the second section. */
    const transcript: TranscriptEntry[] = [
        { startSec: 10, speaker: "S1", text: "We start with the harbor." },
        { startSec: 20, speaker: "S2", text: "The crane is late." },
        { startSec: 30, speaker: "S1", text: "Then we wait." },
        { startSec: 70, speaker: "S1", text: "Back again." },
        { startSec: 80, speaker: "S3", text: "I joined late." },
    ];

    async function assignFixture() {
        const fx = await fixture([], { S2: "Alex Example" });
        const journal = new DecisionJournal({
            store: fx.store,
            ledger: () => undefined,
            split: { transcript: async () => transcript },
            now: () => new Date(now),
        });
        const record = () => fx.store.read(fx.meeting.id)!;
        return { ...fx, journal, record };
    }

    test("a stretch of one label is one assignment, the transcript shows the person, and the token removes it", async () => {
        const fx = await assignFixture();
        const { entry } = await fx.journal.apply({
            meeting: fx.meeting.id,
            action: { kind: "assign", person: "Dana Example", stretches: [{ label: "S1", fromSec: 5, toSec: 35 }] },
            actor: person,
        });

        expect(fx.record().speakers.assignments).toEqual([
            { id: "a1", label: "S1", fromSec: 5, toSec: 35, person: "Dana Example", at: now },
        ]);
        expect(entry?.assignments).toEqual([{ id: "a1", after: fx.record().speakers.assignments![0]! }]);
        const corrected = correctTranscript({
            record: fx.record(),
            transcript,
            config: meetingsConfigSchema.parse({}),
            format: "txt",
        });
        expect(corrected.entries.map((line) => line.speaker)).toEqual([
            "Dana Example",
            "Alex Example",
            "Dana Example",
            "S1",
            "S3",
        ]);
        expect(fx.record().history.at(-1)).toMatchObject({
            command: "speakers assign",
            change: "S1 00:05–00:35 → Dana Example",
        });

        await fx.journal.revert({ meeting: fx.meeting.id, token: entry!.token, actor: person });

        expect(fx.record().speakers).not.toHaveProperty("assignments");
    });

    test("a stretch of every voice and a line by its start find their labels; a line that is not there is skipped", async () => {
        const fx = await assignFixture();
        const { entry, skipped } = await fx.journal.apply({
            meeting: fx.meeting.id,
            action: {
                kind: "assign",
                person: "Kim Example",
                email: "kim@example.com",
                stretches: [{ fromSec: 15, toSec: 32 }],
                lines: [{ atSec: 80, line: 4 }, { atSec: 99 }],
            },
            actor: person,
        });

        expect(fx.record().speakers.assignments?.map((one) => [one.id, one.label, one.fromSec, one.toSec])).toEqual([
            ["a1", "S2", 15, 32],
            ["a2", "S1", 15, 32],
            ["a3", "S3", 80, 80],
        ]);
        expect(fx.record().speakers.assignments?.[0]?.email).toBe("kim@example.com");
        expect(skipped).toEqual([{ id: "line 01:39", reason: "no line starts at 01:39", needs: "nothing" }]);
        expect(entry?.skipped).toEqual(skipped);
    });

    test("the same stretch given to someone else replaces it, and an Undo of the first is refused", async () => {
        const fx = await assignFixture();
        const stretch = { label: "S1", fromSec: 5, toSec: 35 };
        const first = await fx.journal.apply({
            meeting: fx.meeting.id,
            action: { kind: "assign", person: "Dana Example", stretches: [stretch] },
            actor: person,
        });
        const again = await fx.journal.apply({
            meeting: fx.meeting.id,
            action: { kind: "assign", person: "Dana Example", stretches: [stretch] },
            actor: person,
        });
        await fx.journal.apply({
            meeting: fx.meeting.id,
            action: { kind: "assign", person: "Lee Example", stretches: [stretch] },
            actor: person,
        });

        expect(again.entry).toBeUndefined();
        expect(fx.record().speakers.assignments?.map((one) => [one.id, one.person])).toEqual([["a1", "Lee Example"]]);
        await expect(
            fx.journal.revert({ meeting: fx.meeting.id, token: first.entry!.token, actor: person })
        ).rejects.toMatchObject({ code: "item-changed" });
    });

    // record.ts: "A later assignment over the same lines wins". A stretch given again keeps its id, so the order of
    // the acts, not the order of the list, must decide a line two assignments cover.
    test("the latest act wins on a line two assignments cover, also when it gives an earlier stretch again", async () => {
        const fx = await assignFixture();
        let tick = 0;
        const journal = new DecisionJournal({
            store: fx.store,
            ledger: () => undefined,
            split: { transcript: async () => transcript },
            now: () => new Date(Date.parse(now) + 1000 * tick++),
        });
        const give = (who: string, fromSec: number, toSec: number) =>
            journal.apply({
                meeting: fx.meeting.id,
                action: { kind: "assign", person: who, stretches: [{ label: "S1", fromSec, toSec }] },
                actor: person,
            });
        await give("Dana Example", 5, 35);
        const lee = await give("Lee Example", 25, 35);
        const kim = await give("Kim Example", 5, 35);
        const speakers = () =>
            correctTranscript({
                record: fx.record(),
                transcript,
                config: meetingsConfigSchema.parse({}),
                format: "txt",
            }).entries.map((line) => line.speaker);

        expect(speakers()).toEqual(["Kim Example", "Alex Example", "Kim Example", "S1", "S3"]);
        await journal.revert({ meeting: fx.meeting.id, token: kim.entry!.token, actor: person });
        expect(speakers()).toEqual(["Dana Example", "Alex Example", "Lee Example", "S1", "S3"]);
        await journal.revert({ meeting: fx.meeting.id, token: lee.entry!.token, actor: person });
        expect(speakers()).toEqual(["Dana Example", "Alex Example", "Dana Example", "S1", "S3"]);
    });

    test("giving a stretch again to the same person takes back a later assignment inside it", async () => {
        const fx = await assignFixture();
        let tick = 0;
        const journal = new DecisionJournal({
            store: fx.store,
            ledger: () => undefined,
            split: { transcript: async () => transcript },
            now: () => new Date(Date.parse(now) + 1000 * tick++),
        });
        const give = (who: string, fromSec: number, toSec: number) =>
            journal.apply({
                meeting: fx.meeting.id,
                action: { kind: "assign", person: who, stretches: [{ label: "S1", fromSec, toSec }] },
                actor: person,
            });
        await give("Dana Example", 5, 35);
        await give("Lee Example", 25, 35);
        const again = await give("Dana Example", 5, 35);
        const speakers = () =>
            correctTranscript({
                record: fx.record(),
                transcript,
                config: meetingsConfigSchema.parse({}),
                format: "txt",
            }).entries.map((line) => line.speaker);

        expect(again.entry).toBeDefined();
        expect(speakers()).toEqual(["Dana Example", "Alex Example", "Dana Example", "S1", "S3"]);
        expect(fx.record().speakers.assignments?.map((one) => [one.id, one.person])).toEqual([
            ["a1", "Dana Example"],
            ["a2", "Lee Example"],
        ]);
    });

    test("a rename to a name another label holds says both labels become one person (G-PPL-4)", async () => {
        const fx = await assignFixture();
        const planned = await fx.journal.plan({
            meeting: fx.meeting.id,
            action: { kind: "rename", label: "S3", name: "Alex Example" },
            actor: person,
        });

        expect(planned.warnings).toEqual(["S2 is named Alex Example already: S3 and S2 become one person"]);
    });

    test("the reach is the same label in the hint range around it and in the sections with the same people", () => {
        const record = meetingRecordSchema.parse({
            id: "m1",
            title: "Harbor sync",
            start: now,
            createdAt: now,
            createdBy: "new",
            sections: [
                { fromSec: 0, toSec: 40, present: ["Dana Example", "Alex Example"] },
                { fromSec: 40, toSec: 60, present: ["Dana Example"] },
                { fromSec: 60, toSec: 90, present: ["Alex Example", "Dana Example"] },
            ],
        });
        const assigned = [{ id: "a1", label: "S1", fromSec: 9, toSec: 11, person: "Dana Example", at: now }];
        const hints: SpeakerHint[] = [
            { kind: "absent-speaker", label: "S1", strength: "normal", ranges: [{ fromSec: 0, toSec: 35, lines: 2 }] },
        ];

        expect(assignmentReach({ record, transcript, hints, assigned })).toEqual([
            { label: "S1", fromSec: 0, toSec: 35, lines: 1, why: "hint-range" },
            { label: "S1", fromSec: 60, toSec: 90, lines: 1, why: "present-set" },
        ]);
    });
});

/**
 * A word question with a target inside its span (i1) and one outside it (i5), a look-alike over another span (i4,
 * deciding i2) and one over the same span (i6, deciding i7).
 */
const transaction = () => [
    term("i1", 50, { proposed: "ADA" }),
    term("i2", 70, { proposed: "ADA" }),
    term("i5", 120, { proposed: "ADA" }),
    term("i7", 51, { proposed: "ADA" }),
    question("i3", { decides: ["i1", "i5"] }),
    question("i4", { fromSec: 70, toSec: 74, decides: ["i2"] }),
    question("i6", { decides: ["i7"] }),
];

describe("a decision and what it carries are one transaction", () => {
    test("the reach never lists the asked span again, sorts targets from look-alikes, and quotes each item", async () => {
        const fx = await fixture(transaction());
        const record = fx.store.read(fx.meeting.id)!;
        const transcript: TranscriptEntry[] = [
            { speaker: "S1", text: "ada said so", startSec: 50 },
            { speaker: "S2", text: "ada again much later", startSec: 120 },
        ];
        const planned = await fx.journal.plan({
            meeting: fx.meeting.id,
            action: { kind: "answer", question: "i3", answer: "ADO" },
            actor: person,
        });
        const reach = decisionReach({
            entry: planned.entry!,
            named: ["i3"],
            record,
            rowOf: (item) => reviewRow(record, item, transcript),
            ledger: [],
            repeats: 2,
        });

        expect(reach.items.map((item) => [item.id, item.role])).toEqual([
            ["i6", "same"],
            ["i4", "look-alike"],
            ["i1", "same"],
            ["i5", "sets"],
        ]);
        const outside = reach.items.find((item) => item.id === "i5");
        expect(outside).toMatchObject({ before: "ADA", after: "ADO", row: { id: "i5", target: { id: "i5" } } });
        expect(outside?.row?.parts).toContainEqual({ kind: "said", text: "ada again much later" });
        expect(reach.items.find((item) => item.id === "i4")?.row?.label).toBe("Q2");
    });

    test("a struck target and a struck look-alike stay as they were and leave it: the Undo does not touch them", async () => {
        const fx = await fixture(transaction());
        const { entry } = await fx.journal.apply({
            meeting: fx.meeting.id,
            action: { kind: "answer", question: "i3", answer: "ADO", except: ["i5", "i4"] },
            actor: person,
        });

        expect(entry).toMatchObject({ settled: ["i6"] });
        expect(entry?.decided).not.toContain("i5");
        expect(fx.item("i3")).toMatchObject({ status: "confirmed", decides: ["i1"] });
        expect(fx.item("i1")).toMatchObject({ status: "confirmed", proposed: "ADO" });
        expect(fx.item("i7")).toMatchObject({ status: "confirmed", proposed: "ADO" });
        expect(fx.item("i5")).toMatchObject({ status: "suggested", proposed: "ADA" });
        expect(fx.item("i4")).toMatchObject({ status: "suggested" });

        await fx.journal.revert({ meeting: fx.meeting.id, token: entry!.token, actor: person });

        // One Undo takes back the answer and everything it carried, in one step.
        for (const id of ["i1", "i3", "i6", "i7"]) {
            expect(fx.item(id)).toMatchObject({ status: "suggested" });
            expect(fx.item(id)).not.toHaveProperty("decision");
        }

        expect(fx.item("i3")).toMatchObject({ decides: ["i1", "i5"] });
        expect(fx.item("i7")).toMatchObject({ proposed: "ADA" });
        expect(fx.item("i5")).not.toHaveProperty("decision");
    });

    test("a changed answer replaces the earlier one in one entry, keeps the struck items out, and its Undo brings the earlier answer back", async () => {
        const fx = await fixture(transaction());
        const first = await fx.journal.apply({
            meeting: fx.meeting.id,
            action: { kind: "answer", question: "i3", answer: "ADO", except: ["i5"] },
            actor: person,
        });
        const change = { kind: "answer", question: "i3", answer: "ADA", replaces: first.entry!.token } as const;
        const planned = await fx.journal.plan({ meeting: fx.meeting.id, action: change, actor: person });
        const reach = decisionReach({
            entry: planned.entry!,
            named: ["i3"],
            record: fx.store.read(fx.meeting.id)!,
            struck: ["i5"],
            ledger: [],
            repeats: 2,
        });

        // The carried items are asked again with the new answer; the one struck before is struck again.
        expect(reach.items.map((item) => [item.id, item.role, item.after, item.struck ?? false])).toEqual([
            ["i6", "same", "ADA", false],
            ["i4", "look-alike", "ADA", false],
            ["i1", "same", "ADA", false],
            ["i5", "sets", "ADA", true],
        ]);

        const second = await fx.journal.apply({
            meeting: fx.meeting.id,
            action: { ...change, except: ["i5"] },
            actor: person,
        });

        expect(fx.item("i3")).toMatchObject({ status: "confirmed", answer: "ADA", decides: ["i1"] });
        expect(fx.item("i1")).toMatchObject({ status: "confirmed", proposed: "ADA" });
        expect(fx.item("i2")).toMatchObject({ status: "confirmed", proposed: "ADA" });
        expect(fx.item("i5")).toMatchObject({ status: "suggested" });
        expect(fx.item("i5")).not.toHaveProperty("decision");
        expect(fx.journal.read(fx.meeting.id).find((one) => one.token === first.entry!.token)?.revertedBy).toBe(
            second.entry!.token
        );

        await fx.journal.revert({ meeting: fx.meeting.id, token: second.entry!.token, actor: person });

        expect(fx.item("i3")).toMatchObject({ status: "confirmed", answer: "ADO", decides: ["i1"] });
        expect(fx.item("i1")).toMatchObject({ status: "confirmed", proposed: "ADO" });
        // The look-alike the earlier answer settled is back on that answer too.
        expect(fx.item("i4")).toMatchObject({ status: "confirmed", answer: "ADO" });
        expect(fx.item("i2")).toMatchObject({ status: "confirmed", proposed: "ADO" });
        expect(fx.item("i5")).toMatchObject({ status: "suggested", proposed: "ADA" });
        const reopened = new DecisionJournal({ store: new MeetingStore(fx.store.storage), ledger: () => {} });
        const history = reopened.read(fx.meeting.id);
        expect(history.find((one) => one.token === first.entry!.token)?.revertedBy).toBeUndefined();
        expect(history.find((one) => one.token === second.entry!.token)?.revertedBy).toBeDefined();
        await reopened.revert({ meeting: fx.meeting.id, token: first.entry!.token, actor: person });
        expect(
            new MeetingStore(fx.store.storage).read(fx.meeting.id)?.items.every((one) => one.status === "suggested")
        ).toBe(true);
    });

    test("undoing an Undo makes the restored decision live in persisted history again", async () => {
        const fx = await fixture(lookAlikes());
        const first = await fx.journal.apply({
            meeting: fx.meeting.id,
            action: { kind: "answer", question: "i3", answer: "ADO" },
            actor: person,
        });
        const undo = await fx.journal.revert({ meeting: fx.meeting.id, token: first.entry!.token, actor: person });
        await fx.journal.revert({ meeting: fx.meeting.id, token: undo.entry!.token, actor: person });
        const store = new MeetingStore(fx.store.storage);
        const reopened = new DecisionJournal({ store, ledger: () => {} });
        expect(
            reopened.read(fx.meeting.id).find((entry) => entry.token === first.entry!.token)?.revertedBy
        ).toBeUndefined();
        expect(store.read(fx.meeting.id)?.items.find((item) => item.id === "i3")).toMatchObject({
            answer: "ADO",
            status: "confirmed",
            decision: { token: first.entry!.token },
        });
    });

    for (const { except, preserved } of [
        { except: "i1", preserved: ["i1"] },
        { except: "i4", preserved: ["i4", "i2"] },
    ]) {
        test(`changing an answer leaves the struck ${except} and its effects as they were`, async () => {
            const fx = await fixture(lookAlikes());
            const first = await fx.journal.apply({
                meeting: fx.meeting.id,
                action: { kind: "answer", question: "i3", answer: "ADO" },
                actor: person,
            });
            const before = new MeetingStore(fx.store.storage).read(fx.meeting.id)!;
            const second = await fx.journal.apply({
                meeting: fx.meeting.id,
                action: {
                    kind: "answer",
                    question: "i3",
                    answer: "ADA",
                    replaces: first.entry!.token,
                    except: [except],
                },
                actor: person,
            });
            const store = new MeetingStore(fx.store.storage);
            const after = store.read(fx.meeting.id)!;
            expect(after.items.find((item) => item.id === "i3")).toMatchObject({ answer: "ADA", status: "confirmed" });
            for (const id of preserved) {
                expect(after.items.find((item) => item.id === id)).toEqual(before.items.find((item) => item.id === id));
                expect(second.entry?.changes.some((change) => change.id === id)).toBe(false);
            }
            const reopened = new DecisionJournal({ store, ledger: () => {} });
            expect(
                reopened.read(fx.meeting.id).find((entry) => entry.token === first.entry!.token)?.revertedBy
            ).toBeUndefined();
            await reopened.revert({ meeting: fx.meeting.id, token: second.entry!.token, actor: person });
            expect(new MeetingStore(fx.store.storage).read(fx.meeting.id)!.items).toEqual(before.items);
        });
    }

    for (const changed of ["i1", "i2"]) {
        test(`changing an answer preserves ${changed} decided again and can itself be undone after reopening the store`, async () => {
            const fx = await fixture(lookAlikes());
            const first = await fx.journal.apply({
                meeting: fx.meeting.id,
                action: { kind: "answer", question: "i3", answer: "ADO" },
                actor: person,
            });
            await fx.journal.revert({
                meeting: fx.meeting.id,
                token: first.entry!.token,
                items: [changed],
                actor: person,
            });
            await fx.journal.apply({
                meeting: fx.meeting.id,
                action: { kind: "respell", item: changed, text: "Ado" },
                actor: person,
            });
            const before = new MeetingStore(fx.store.storage).read(fx.meeting.id)!;
            const action = { kind: "answer", question: "i3", answer: "ADA", replaces: first.entry!.token } as const;
            const planned = await fx.journal.plan({ meeting: fx.meeting.id, action, actor: person });
            expect(planned.entry?.skipped).toContainEqual(expect.objectContaining({ id: changed }));
            expect(new MeetingStore(fx.store.storage).read(fx.meeting.id)).toEqual(before);
            const second = await fx.journal.apply({ meeting: fx.meeting.id, action, actor: person });
            const store = new MeetingStore(fx.store.storage);
            const after = store.read(fx.meeting.id)!;
            expect(after.items.find((item) => item.id === changed)).toEqual(
                before.items.find((item) => item.id === changed)
            );
            expect(after.items.find((item) => item.id === "i3")).toMatchObject({ answer: "ADA", status: "confirmed" });
            await new DecisionJournal({ store, ledger: () => {} }).revert({
                meeting: fx.meeting.id,
                token: second.entry!.token,
                actor: person,
            });
            expect(new MeetingStore(fx.store.storage).read(fx.meeting.id)!.items).toEqual(before.items);
        });
    }

    for (const { selected, preserved } of [
        { selected: "i3", preserved: ["i4", "i2"] },
        { selected: "i4", preserved: ["i3", "i1"] },
    ]) {
        test(`changing only ${selected} keeps the other earlier answer and its target`, async () => {
            const fx = await fixture(lookAlikes());
            const first = await fx.journal.apply({
                meeting: fx.meeting.id,
                action: { kind: "answer", question: "i3", answer: "ADO" },
                actor: person,
            });
            const before = new MeetingStore(fx.store.storage).read(fx.meeting.id)!;
            const second = await fx.journal.apply({
                meeting: fx.meeting.id,
                action: {
                    kind: "answer",
                    question: selected,
                    answer: "ADA",
                    replaces: first.entry!.token,
                    lookAlikes: "leave",
                },
                actor: person,
            });
            const after = new MeetingStore(fx.store.storage).read(fx.meeting.id)!;
            expect(after.items.find((item) => item.id === selected)).toMatchObject({
                answer: "ADA",
                status: "confirmed",
            });
            for (const id of preserved) {
                expect(after.items.find((item) => item.id === id)).toEqual(before.items.find((item) => item.id === id));
                expect(second.entry?.changes.some((change) => change.id === id)).toBe(false);
                expect(second.entry?.corrections.some((line) => line.item === id)).toBe(false);
            }
            await new DecisionJournal({ store: new MeetingStore(fx.store.storage), ledger: () => {} }).revert({
                meeting: fx.meeting.id,
                token: second.entry!.token,
                actor: person,
            });
            expect(new MeetingStore(fx.store.storage).read(fx.meeting.id)!.items).toEqual(before.items);
        });
    }

    for (const initiallyStruck of [false, true]) {
        test(`another replacement preserves an independently decided target (initially struck: ${initiallyStruck})`, async () => {
            const fx = await fixture(lookAlikes());
            const first = await fx.journal.apply({
                meeting: fx.meeting.id,
                action: {
                    kind: "answer",
                    question: "i3",
                    answer: "ADO",
                    ...(initiallyStruck ? { except: ["i1"] } : {}),
                },
                actor: person,
            });
            if (!initiallyStruck) {
                await fx.journal.revert({
                    meeting: fx.meeting.id,
                    token: first.entry!.token,
                    items: ["i1"],
                    actor: person,
                });
            }
            await fx.journal.apply({
                meeting: fx.meeting.id,
                action: { kind: "respell", item: "i1", text: "Ado" },
                actor: person,
            });
            const preceding = initiallyStruck
                ? first
                : await fx.journal.apply({
                      meeting: fx.meeting.id,
                      action: { kind: "answer", question: "i3", answer: "ADA", replaces: first.entry!.token },
                      actor: person,
                  });
            const store = new MeetingStore(fx.store.storage);
            const reopened = new DecisionJournal({ store, ledger: (lines) => fx.ledger.push(...lines) });
            const before = store.read(fx.meeting.id)!;
            const history = readFileSync(reopened.path(fx.meeting.id), "utf8");
            const contribution = fx.ledger.filter((line) => line.item === "i1");
            const action = { kind: "answer", question: "i3", answer: "ADP", replaces: preceding.entry!.token } as const;
            const plan = await reopened.plan({ meeting: fx.meeting.id, action, actor: person });
            expect(plan.entry?.skipped).toContainEqual(expect.objectContaining({ id: "i1" }));
            expect(new MeetingStore(fx.store.storage).read(fx.meeting.id)).toEqual(before);
            expect(readFileSync(reopened.path(fx.meeting.id), "utf8")).toBe(history);
            const next = await reopened.apply({ meeting: fx.meeting.id, action, actor: person });
            expect(
                new MeetingStore(fx.store.storage).read(fx.meeting.id)!.items.find((item) => item.id === "i3")
            ).toMatchObject({
                answer: "ADP",
                status: "confirmed",
            });
            expect(
                new MeetingStore(fx.store.storage).read(fx.meeting.id)!.items.find((item) => item.id === "i1")
            ).toEqual(before.items.find((item) => item.id === "i1"));
            expect(next.entry?.changes.some((change) => change.id === "i1")).toBe(false);
            expect(next.entry?.corrections.some((line) => line.item === "i1")).toBe(false);
            expect(fx.ledger.filter((line) => line.item === "i1")).toEqual(contribution);
            await new DecisionJournal({ store: new MeetingStore(fx.store.storage), ledger: () => {} }).revert({
                meeting: fx.meeting.id,
                token: next.entry!.token,
                actor: person,
            });
            expect(new MeetingStore(fx.store.storage).read(fx.meeting.id)!.items).toEqual(before.items);
        });
    }

    test("a replacement can reattach an untouched suggested target", async () => {
        const fx = await fixture(lookAlikes());
        const first = await fx.journal.apply({
            meeting: fx.meeting.id,
            action: { kind: "answer", question: "i3", answer: "ADO", except: ["i1"] },
            actor: person,
        });
        await new DecisionJournal({ store: new MeetingStore(fx.store.storage), ledger: () => {} }).apply({
            meeting: fx.meeting.id,
            action: { kind: "answer", question: "i3", answer: "ADA", replaces: first.entry!.token },
            actor: person,
        });
        expect(
            new MeetingStore(fx.store.storage).read(fx.meeting.id)!.items.find((item) => item.id === "i1")
        ).toMatchObject({
            status: "confirmed",
            proposed: "ADA",
        });
    });

    test("a stale replacement refuses the primary question without undoing any of its current targets", async () => {
        const fx = await fixture(lookAlikes());
        const first = await fx.journal.apply({
            meeting: fx.meeting.id,
            action: { kind: "answer", question: "i3", answer: "ADO" },
            actor: person,
        });
        await fx.journal.apply({
            meeting: fx.meeting.id,
            action: { kind: "answer", question: "i3", answer: "ADA", replaces: first.entry!.token },
            actor: person,
        });
        const before = new MeetingStore(fx.store.storage).read(fx.meeting.id);
        const journal = readFileSync(fx.journal.path(fx.meeting.id), "utf8");
        for (const method of ["plan", "apply"] as const) {
            await expect(
                fx.journal[method]({
                    meeting: fx.meeting.id,
                    action: { kind: "answer", question: "i3", answer: "ADO", replaces: first.entry!.token },
                    actor: person,
                })
            ).rejects.toThrow("decided again");
            expect(new MeetingStore(fx.store.storage).read(fx.meeting.id)).toEqual(before);
            expect(readFileSync(fx.journal.path(fx.meeting.id), "utf8")).toBe(journal);
        }
    });

    test("a changed speaker answer does not propagate over an independently decided range", async () => {
        const range = (id: string) => ({
            id,
            kind: "speaker-range",
            status: "suggested",
            fromSec: 50,
            toSec: 54,
            label: "voice",
            speaker: "Unclear",
            confidence: 0.7,
            rules: [],
            suggestedAt: now,
        });
        const speakerQuestion = (id: string, target: string) =>
            question(id, {
                about: "speaker",
                signature: "same-voice",
                evidence: { labels: ["voice"] },
                choices: ["Alice", "Bob", "Casey"],
                decides: [target],
            });
        const fx = await fixture([range("i1"), range("i2"), speakerQuestion("i3", "i1"), speakerQuestion("i4", "i2")]);
        const first = await fx.journal.apply({
            meeting: fx.meeting.id,
            action: { kind: "answer", question: "i3", answer: "Alice" },
            actor: person,
        });
        expect(first.entry?.settled).toContain("i4");
        await fx.journal.revert({ meeting: fx.meeting.id, token: first.entry!.token, items: ["i2"], actor: person });
        await fx.journal.apply({
            meeting: fx.meeting.id,
            action: { kind: "respell", item: "i2", text: "Bob" },
            actor: person,
        });
        const before = new MeetingStore(fx.store.storage).read(fx.meeting.id)!;
        const second = await fx.journal.apply({
            meeting: fx.meeting.id,
            action: { kind: "answer", question: "i3", answer: "Casey", replaces: first.entry!.token },
            actor: person,
        });
        const after = new MeetingStore(fx.store.storage).read(fx.meeting.id)!;
        expect(after.items.find((item) => item.id === "i2")).toEqual(before.items.find((item) => item.id === "i2"));
        expect(after.items.find((item) => item.id === "i1")).toMatchObject({ speaker: "Casey" });
        await new DecisionJournal({ store: new MeetingStore(fx.store.storage), ledger: () => {} }).revert({
            meeting: fx.meeting.id,
            token: second.entry!.token,
            actor: person,
        });
        expect(new MeetingStore(fx.store.storage).read(fx.meeting.id)!.items).toEqual(before.items);
    });

    test("a replacement token must name an answer that decided this question", async () => {
        const fx = await fixture([...lookAlikes(), question("i5", { heard: "Different", choices: ["One", "Two"] })], {
            voice: "Earlier label",
        });
        const rename = await fx.journal.apply({
            meeting: fx.meeting.id,
            action: { kind: "rename", label: "voice", name: "Current label" },
            actor: person,
        });
        const other = await fx.journal.apply({
            meeting: fx.meeting.id,
            action: { kind: "answer", question: "i5", answer: "One" },
            actor: person,
        });
        const before = new MeetingStore(fx.store.storage).read(fx.meeting.id);
        const history = readFileSync(fx.journal.path(fx.meeting.id), "utf8");
        for (const token of [rename.entry!.token, other.entry!.token, "missing-token"]) {
            for (const method of ["plan", "apply"] as const) {
                await expect(
                    fx.journal[method]({
                        meeting: fx.meeting.id,
                        action: { kind: "answer", question: "i3", answer: "ADO", replaces: token },
                        actor: person,
                    })
                ).rejects.toThrow("earlier answer to this question");
                expect(new MeetingStore(fx.store.storage).read(fx.meeting.id)).toEqual(before);
                expect(readFileSync(fx.journal.path(fx.meeting.id), "utf8")).toBe(history);
            }
        }
    });

    test("an answer may replace the answer that settled it as a look-alike", async () => {
        const fx = await fixture(lookAlikes());
        const first = await fx.journal.apply({
            meeting: fx.meeting.id,
            action: { kind: "answer", question: "i3", answer: "ADO" },
            actor: person,
        });
        const second = await fx.journal.apply({
            meeting: fx.meeting.id,
            action: { kind: "answer", question: "Q2", answer: "ADA", replaces: first.entry!.token },
            actor: person,
        });
        expect(second.entry?.question).toBe("i4");
        expect(
            new MeetingStore(fx.store.storage).read(fx.meeting.id)?.items.find((one) => one.id === "i4")
        ).toMatchObject({ answer: "ADA", status: "confirmed" });
    });
});

describe("workshop listen contracts", () => {
    test("unmatched prose persists as a comment and never becomes a speaker", async () => {
        const fx = await fixture([
            {
                id: "i1",
                kind: "speaker-range",
                status: "suggested",
                label: "Voice",
                fromSec: 10,
                toSec: 10,
                speaker: "Alice Example",
                rules: [],
                suggestedAt: now,
            },
            question("i2", {
                about: "speaker",
                heard: undefined,
                fromSec: 10,
                toSec: 10,
                choices: ["Alice Example", "Bob Example"],
                decides: ["i1"],
            }),
        ]);
        await fx.journal.apply({
            meeting: fx.meeting.id,
            actor: person,
            action: { kind: "answer", question: "i2", answer: "I cannot hear the second sentence" },
        });
        const reopened = new MeetingStore(fx.store.storage).read(fx.meeting.id)!;
        expect(reopened.items.find((item) => item.id === "i2")).toMatchObject({
            status: "suggested",
            comment: "I cannot hear the second sentence",
        });
        expect(reopened.items.find((item) => item.id === "i1")).toMatchObject({
            status: "suggested",
            speaker: "Alice Example",
        });
    });

    test("a look-alike takes the matched person's stored name, and an ordered pair of people settles none", async () => {
        const range = (id: string, fromSec: number) => ({
            id,
            kind: "speaker-range",
            status: "suggested",
            label: "Voice",
            fromSec,
            toSec: fromSec,
            confidence: 0.5,
            rules: [],
            suggestedAt: now,
        });
        const voiceQuestion = (id: string, fromSec: number, decides: string) =>
            question(id, {
                about: "speaker",
                heard: undefined,
                fromSec,
                toSec: fromSec,
                signature: "voice-1",
                evidence: { labels: ["Voice"] },
                choices: ["Alice Example", "Bob Example"],
                decides: [decides],
            });
        const items = () => [
            range("i1", 10),
            voiceQuestion("i2", 10, "i1"),
            range("i3", 40),
            voiceQuestion("i4", 40, "i3"),
        ];
        const fx = await fixture(items());
        const { entry } = await fx.journal.apply({
            meeting: fx.meeting.id,
            actor: person,
            action: { kind: "answer", question: "i2", answer: "example alice" },
        });
        expect(entry?.settled).toEqual(["i4"]);
        expect(fx.item("i3")).toMatchObject({ speaker: "Alice Example" });

        const pair = await fixture(items());
        const ordered = await pair.journal.apply({
            meeting: pair.meeting.id,
            actor: person,
            action: { kind: "answer", question: "i2", answer: "Alice Example, then Bob Example" },
        });
        expect(ordered.entry?.settled).toEqual([]);
        expect(pair.item("i4")).toMatchObject({ status: "suggested" });
    });

    test("ordered people persist word segments and render separate turns", async () => {
        const fx = await fixture([
            {
                id: "i1",
                kind: "speaker-range",
                status: "suggested",
                label: "Voice",
                fromSec: 10,
                toSec: 10,
                rules: [],
                suggestedAt: now,
            },
            question("i2", {
                about: "speaker",
                heard: undefined,
                fromSec: 10,
                toSec: 10,
                choices: ["Alice Example", "Bob Example"],
                decides: ["i1"],
            }),
        ]);
        const transcript = [{ startSec: 10, speaker: "Voice", text: "First sentence. Second sentence." }];
        const journal = new DecisionJournal({
            store: fx.store,
            split: { transcript: async () => transcript },
            ledger: () => {},
            now: () => new Date(now),
        });
        await journal.apply({
            meeting: fx.meeting.id,
            actor: person,
            action: { kind: "answer", question: "i2", answer: "Alice Example, then Bob Example" },
        });
        const reopened = new MeetingStore(fx.store.storage).read(fx.meeting.id)!;
        expect(reopened.items.find((item) => item.id === "i1")).toMatchObject({
            segments: [
                { fromWord: 0, speaker: "Alice Example" },
                { fromWord: 2, speaker: "Bob Example" },
            ],
        });
        expect(
            correctTranscript({
                record: reopened,
                transcript,
                config: meetingsConfigSchema.parse({}),
                format: "txt",
            }).entries.map((entry) => [entry.speaker, entry.text])
        ).toEqual([
            ["Alice Example", "First sentence."],
            ["Bob Example", "Second sentence."],
        ]);
    });

    test("name matching ignores accents and order, but never turns a comment into an invented identity", () => {
        expect(personKey("Éxample Alice")).toBe(personKey("Alice Example"));
        expect(parsePersonAnswer({ text: "example alice", people: ["Alice Example"] })).toEqual({
            kind: "people",
            people: ["Alice Example"],
        });
        expect(parsePersonAnswer({ text: "this sounded unclear", people: ["Alice Example"] }).kind).toBe("comment");
        expect(
            parsePersonAnswer({
                text: "me, then someone I cannot identify",
                people: ["Alice Example"],
                self: "Alice Example",
            }).kind
        ).toBe("comment");
        expect(
            parsePersonAnswer({
                text: "Alice Example, then Bob Example",
                people: ["Alice Example", "Alice Example (Engineering)", "Bob Example"],
            })
        ).toEqual({ kind: "people", people: ["Alice Example", "Bob Example"] });
    });

    test("roster first seen and identified departure survive persisted roundtrip", async () => {
        const fx = await fixture([]);
        await fx.store.update(fx.meeting.id, { command: "test", change: "roster" }, (record) => {
            record.participants = [
                { name: "Alice Example", self: true, firstSeenSec: 0, from: ["platform-roster"] },
                { name: "Bob Example", firstSeenSec: 600, from: ["platform-roster"] },
            ];
            const derived = personStays({
                record,
                durationSec: 3000,
                departures: [{ name: "Bob Example", atSec: 2400, reason: "sole-remote" }],
            });
            record.participants = record.participants.map((person) => ({
                ...person,
                stays: derived.find((one) => one.name === person.name)!.stays,
            }));
        });
        const reopened = new MeetingStore(fx.store.storage).read(fx.meeting.id)!;
        expect(reopened.participants[1]).toMatchObject({
            firstSeenSec: 600,
            stays: [{ fromSec: 600, toSec: 2400, source: "goodbye", confidence: 0.8 }],
        });
    });

    test("later attendance replaces roster stays after reopen and preserves manual windows", async () => {
        const fx = await fixture([]);
        await fx.store.update(fx.meeting.id, { command: "test", change: "late attendance" }, (record) => {
            record.participants = [
                {
                    name: "Bob Example",
                    firstSeenSec: 600,
                    from: ["platform-roster"],
                    stays: [{ fromSec: 600, source: "platform-roster", confidence: 1 }],
                },
            ];
            record.attendance = {
                from: "teams",
                people: [{ name: "Bob Example", fromSec: 550, toSec: 2405, joinedAtExact: true, leftAtExact: true }],
            };
        });
        let reopened = new MeetingStore(fx.store.storage).read(fx.meeting.id)!;
        const derived = personStays({ record: reopened, durationSec: 3000 });
        expect(derived[0]!.stays).toEqual([{ fromSec: 550, toSec: 2405, source: "attendance", confidence: 1 }]);
        await fx.store.update(fx.meeting.id, { command: "test", change: "persist stays" }, (record) => {
            record.participants[0]!.stays = derived[0]!.stays;
        });
        reopened = new MeetingStore(fx.store.storage).read(fx.meeting.id)!;
        expect(reopened.participants[0]!.firstSeenSec).toBe(600);
        expect(reopened.participants[0]!.stays).toEqual(derived[0]!.stays);
        await fx.store.update(fx.meeting.id, { command: "test", change: "refresh attendance" }, (record) => {
            record.attendance!.people[0]!.toSec = 2500;
        });
        reopened = new MeetingStore(fx.store.storage).read(fx.meeting.id)!;
        expect(personStays({ record: reopened, durationSec: 3000 })[0]!.stays[0]!.toSec).toBe(2500);
        await fx.store.update(fx.meeting.id, { command: "test", change: "manual window" }, (record) => {
            record.participants[0]!.stays = [{ fromSec: 700, toSec: 2000, source: "hand", confidence: 1 }];
        });
        reopened = new MeetingStore(fx.store.storage).read(fx.meeting.id)!;
        expect(personStays({ record: reopened, durationSec: 3000 })[0]!.stays).toEqual([
            { fromSec: 700, toSec: 2000, source: "hand", confidence: 1 },
        ]);
    });

    test("quality probe conserves lines, sample has no replacement, alternating features split four parts", () => {
        const record = meetingRecordSchema.parse({
            id: "quality",
            title: "",
            start: now,
            createdAt: now,
            createdBy: "new",
            items: [0.55, 0.75, 0.95].map((confidence, index) => ({
                id: "i" + (index + 1),
                kind: "speaker-range",
                label: "Voice",
                fromSec: index * 10,
                toSec: index * 10,
                confidence,
                speaker: "Alice Example",
                rules: [],
                status: "suggested",
                suggestedAt: now,
            })),
        });
        const entries = [0, 10, 20].map((startSec) => ({ startSec, speaker: "Voice", text: "one two three" }));
        const lines = qualityLines(record, entries);
        expect(thresholdProbe(lines, [50, 70, 90]).map((row) => [row.applied, row.open])).toEqual([
            [3, 0],
            [2, 1],
            [1, 2],
        ]);
        expect(sampleLines(lines, 20, () => 0.5)).toHaveLength(1);
        expect(addQualityQuestions({ record, entries, spotCheck: 20 })).toHaveLength(1);
        const prepared = record.items.find((item) => item.kind === "question" && item.group === "spot-check");
        expect(prepared).toMatchObject({ priority: 1, confidence: 0.55 });
        if (prepared?.kind !== "question") {
            throw new Error("The quality question was not prepared");
        }
        delete prepared.priority;
        delete prepared.confidence;
        expect(addQualityQuestions({ record, entries, spotCheck: 20 })).toEqual([prepared.id]);
        expect(prepared).toMatchObject({ priority: 1, confidence: 0.55 });
        prepared.priority = 2.5;
        prepared.confidence = 0.6;
        expect(addQualityQuestions({ record, entries, spotCheck: 20 })).toEqual([prepared.id]);
        expect(prepared).toMatchObject({ priority: 2.5, confidence: 0.6 });
        const parts = splitVoiceStretch(
            Array.from({ length: 12 }, (_, index) => ({ pitchHz: Math.floor(index / 3) % 2 ? 210 : 120 }))
        );
        expect(parts.map((part) => part.length)).toEqual([3, 3, 3, 3]);
    });

    test("remote enrolment excludes mixed windows and held-out scoring uses canonical model gate", () => {
        const record = meetingRecordSchema.parse({
            id: "voice",
            title: "",
            start: now,
            createdAt: now,
            createdBy: "new",
        });
        const channel = (fromSec: number, embedding: number[]) => ({
            quality: "ready" as const,
            track: "isolated-call" as const,
            source: { audioPath: "/fixture.wav", size: 42, mtimeMs: 1 },
            channel: 1 as const,
            model: "fixture-model",
            fromSec,
            toSec: fromSec + 3,
            embedding,
        });
        const embeddings = [
            { index: 0, channels: [channel(0, [1, 0])] },
            { index: 1, channels: [channel(10, [0, 1])] },
            { index: 2, channels: [channel(20, [0, 1])] },
        ];
        const samples = enrolRemoteVoices({
            record,
            embeddings,
            remote: [
                { name: "Alice Example", fromSec: 0, toSec: 5 },
                { name: "Bob Example", fromSec: 10, toSec: 30 },
            ],
        });
        expect(samples).toHaveLength(3);
        expect(scoreRemoteLines({ embeddings, samples }).find((line) => line.index === 2)?.match.person).toBe(
            "Bob Example"
        );
    });
});

test("speaker evidence propagation improves unasked compatible ranges and the journal can undo it", async () => {
    const range = (id: string, fromSec: number, signature = "group-a") => ({
        id,
        kind: "speaker-range",
        status: "suggested",
        label: "Voice",
        fromSec,
        toSec: fromSec,
        speaker: "Bob Example",
        confidence: 0.55,
        rules: [],
        suggestedAt: now,
        evidence: { signature, choices: ["Alice Example", "Bob Example"] },
    });
    const fx = await fixture([
        range("i1", 10),
        range("i2", 20),
        range("i3", 30, "other-group"),
        question("i4", {
            about: "speaker",
            heard: undefined,
            fromSec: 10,
            toSec: 10,
            signature: "group-a",
            evidence: { labels: ["Voice"] },
            choices: ["Alice Example", "Bob Example"],
            decides: ["i1"],
        }),
    ]);
    const before = new MeetingStore(fx.store.storage).read(fx.meeting.id)!;
    const result = await fx.journal.apply({
        meeting: fx.meeting.id,
        actor: person,
        action: { kind: "answer", question: "i4", answer: "Alice Example" },
    });
    const reopened = new MeetingStore(fx.store.storage).read(fx.meeting.id)!;
    expect(reopened.items.find((item) => item.id === "i2")).toMatchObject({
        speaker: "Alice Example",
        confidence: 0.85,
        status: "suggested",
        evidence: { propagatedFrom: "i4" },
    });
    expect(reopened.items.find((item) => item.id === "i3")).toEqual(before.items.find((item) => item.id === "i3"));
    await fx.journal.revert({ meeting: fx.meeting.id, actor: person, token: result.entry!.token });
    expect(new MeetingStore(fx.store.storage).read(fx.meeting.id)!.items).toEqual(before.items);
});

test("a resolved departure is vetoed by later valid speech, and silence needs observed quiet call coverage", () => {
    const record = meetingRecordSchema.parse({
        id: "stays",
        title: "",
        start: now,
        createdAt: now,
        createdBy: "new",
        participants: [{ name: "Bob Example", firstSeenSec: 0, from: ["platform-roster"] }],
    });
    const lines = lineEvidence(
        [
            { speaker: "Voice", startSec: 5, text: "Hello" },
            { speaker: "Voice", startSec: 90, text: "I am still here" },
        ],
        {
            segments: [],
            speaking: [
                { tSec: 5, speaking: ["Bob Example"], validUntilSec: 15 },
                { tSec: 90, speaking: ["Bob Example"], validUntilSec: 100 },
            ],
        }
    );
    expect(
        personStays({
            record,
            durationSec: 900,
            lines,
            departures: [{ name: "Bob Example", atSec: 40, reason: "indicator" }],
        })[0]!.stays[0]!.toSec
    ).toBeUndefined();
    expect(personStays({ record, durationSec: 900, lines, silenceMinutes: 10 })[0]!.stays[0]!.toSec).toBeUndefined();
    const quiet = personStays({
        record,
        durationSec: 900,
        lines,
        silenceMinutes: 10,
        callSilent: [{ fromSec: 94, toSec: 900 }],
    })[0]!.stays[0]!;
    expect(quiet).toMatchObject({ toSec: 95, source: "silence", confidence: 0.5 });
    record.participants[0]!.stays = [{ fromSec: 0, toSec: 40, source: "hand", confidence: 1 }];
    expect(personPresent(record, "Bob Example", 39.9)).toBe(true);
    expect(personPresent(record, "Bob Example", 40)).toBe(false);
    // Imported attendance does not override a hand-corrected stay, as it does not in personStays.
    record.attendance = { from: "teams", people: [{ name: "Bob Example", fromSec: 0, toSec: 900 }] };
    expect(personPresent(record, "Bob Example", 100)).toBe(false);
    expect(personStays({ record, durationSec: 900 })[0]!.stays).toEqual([
        { fromSec: 0, toSec: 40, source: "hand", confidence: 1 },
    ]);
});

test("a later matched voice vetoes a silence departure, as it vetoes an explicit one", () => {
    const transcript = [
        { speaker: "Voice", startSec: 5, text: "Hello" },
        { speaker: "Voice", startSec: 90, text: "I am still here" },
        { speaker: "Voice", startSec: 800, text: "Someone else" },
        { speaker: "Voice", startSec: 1000, text: "One more thing" },
    ];
    // Bob's last indicator line runs to the next line (800); his voice is matched again at 1000.
    const lines = lineEvidence(transcript, {
        segments: [],
        speaking: [
            { tSec: 5, speaking: ["Bob Example"], validUntilSec: 15 },
            { tSec: 90, speaking: ["Bob Example"], validUntilSec: 100 },
            { tSec: 800, speaking: [], validUntilSec: 810 },
            { tSec: 1000, speaking: [], validUntilSec: 1010 },
        ],
    });
    const record = meetingRecordSchema.parse({
        id: "stays-voice",
        title: "",
        start: now,
        createdAt: now,
        createdBy: "new",
        participants: [{ name: "Bob Example", firstSeenSec: 0, from: ["platform-roster"] }],
    });
    const quiet = () =>
        personStays({
            record,
            durationSec: 2000,
            lines,
            silenceMinutes: 10,
            callSilent: [{ fromSec: 94, toSec: 2000 }],
        })[0]!.stays[0]!.toSec;

    expect(quiet()).toBeDefined();
    record.evidence = {
        voice: {
            version: 1,
            source: "fixture",
            enrolment: "fixture",
            lines: {
                "3": { candidates: [], person: "Bob Example", quality: "matched", reason: "fixture", model: "m" },
            },
        },
    };
    expect(quiet()).toBeUndefined();
});

test("an identified goodbye ends an attendance stay whose leave the platform did not record exactly", () => {
    const lines = lineEvidence([{ speaker: "Voice", startSec: 5, text: "Hello" }], {
        segments: [],
        speaking: [{ tSec: 5, speaking: ["Bob Example"], validUntilSec: 15 }],
    });
    const stays = (leftAtExact?: boolean) =>
        personStays({
            record: meetingRecordSchema.parse({
                id: "stays-inexact",
                title: "",
                start: now,
                createdAt: now,
                createdBy: "new",
                participants: [
                    { name: "Bob Example", stays: [{ fromSec: 0, toSec: 300, source: "goodbye" }], from: [] },
                ],
                attendance: {
                    from: "teams",
                    people: [
                        {
                            name: "Bob Example",
                            fromSec: 0,
                            toSec: 600,
                            ...(leftAtExact === undefined ? {} : { leftAtExact }),
                        },
                    ],
                },
            }),
            durationSec: 900,
            lines,
            departures: [{ name: "Bob Example", atSec: 300, reason: "indicator" }],
        })[0]!.stays;

    // A roster stay with no end runs to the transcript's end, a bound a departure resolver must not read as a leave.
    const roster = meetingRecordSchema.parse({
        id: "roster-bound",
        title: "",
        start: now,
        createdAt: now,
        createdBy: "new",
        participants: [{ name: "Bob Example", firstSeenSec: 60, from: ["platform-roster"] }],
    });
    expect(rosterPresence(roster, 900)).toEqual([
        { name: "Bob Example", self: undefined, fromSec: 60, toSec: 900, leftAtExact: false },
    ]);
    expect(stays(false)).toEqual([{ fromSec: 0, toSec: 300, source: "goodbye", confidence: 0.8 }]);
    expect(stays(undefined)).toEqual([{ fromSec: 0, toSec: 600, source: "attendance", confidence: 1 }]);
    expect(stays(true)).toEqual([{ fromSec: 0, toSec: 600, source: "attendance", confidence: 1 }]);
});

test("a name in prose that does not identify the speaker stays a comment", () => {
    const people = ["Alice Example", "Bob Example"];

    for (const text of [
        "not Alice Example",
        "I cannot tell whether this is Alice Example",
        "Alice Example or Bob Example",
    ]) {
        expect(parsePersonAnswer({ text, people })).toEqual({ kind: "comment", text });
    }

    expect(parsePersonAnswer({ text: "it's Alice Example", people })).toEqual({
        kind: "people",
        people: ["Alice Example"],
    });
    expect(parsePersonAnswer({ text: "Alice Example and Bob Example", people })).toEqual({
        kind: "people",
        people: ["Alice Example", "Bob Example"],
    });
    expect(parsePersonAnswer({ text: "me and Bob Example", people, self: "Alice Example" })).toEqual({
        kind: "people",
        people: ["Alice Example", "Bob Example"],
    });
    expect(parsePersonAnswer({ text: "me and Bob Example", people }).kind).toBe("comment");
});

test("the threshold probe never counts a range an open speaker question decides as applied", () => {
    const record = meetingRecordSchema.parse({
        id: "probe-owned",
        title: "",
        start: now,
        createdAt: now,
        createdBy: "new",
        items: [
            {
                id: "i1",
                kind: "speaker-range",
                label: "Voice",
                fromSec: 0,
                toSec: 0,
                confidence: 0.95,
                speaker: "Alice Example",
                rules: [],
                status: "suggested",
                suggestedAt: now,
            },
            {
                id: "i2",
                kind: "question",
                status: "suggested",
                about: "speaker",
                fromSec: 30,
                toSec: 40,
                question: "Who?",
                choices: ["Alice Example"],
                decides: ["i1"],
                rules: [],
                suggestedAt: now,
            },
        ],
    });
    const lines = qualityLines(record, [{ startSec: 0, speaker: "Voice", text: "one two three" }]);

    expect(thresholdProbe(lines, [70]).map((row) => [row.applied, row.guesses, row.open])).toEqual([[0, 1, 1]]);
});

test("remote held-out fixture attributes at least ninety percent and unavailable extraction stays explicit", () => {
    const source = { audioPath: "/fixture.wav", size: 42, mtimeMs: 1 };
    const samples = ["Alice Example", "Bob Example"].map((person, index) => ({
        person,
        source: source.audioPath,
        model: "fixture-model",
        channel: 1 as const,
        fromSec: index * 5,
        toSec: index * 5 + 3,
        embedding: index ? [0, 1] : [1, 0],
        confirmed: true as const,
    }));
    const held = Array.from({ length: 20 }, (_, index) => ({
        index,
        channels: [
            {
                quality: "ready" as const,
                track: "isolated-call" as const,
                source,
                channel: 1 as const,
                model: "fixture-model",
                fromSec: 100 + index * 5,
                toSec: 103 + index * 5,
                embedding: index % 2 ? [0.01, 1] : [1, 0.01],
            },
        ],
    }));
    const matches = scoreRemoteLines({ embeddings: held, samples });
    expect(
        matches.filter((line) => line.match.person === samples[line.index % 2]!.person).length / held.length
    ).toBeGreaterThanOrEqual(0.9);
    expect(
        scoreRemoteLines({
            embeddings: [
                {
                    index: 21,
                    channels: [
                        {
                            quality: "unknown",
                            reason: "too quiet",
                            track: "isolated-call",
                            source,
                            channel: 1,
                            fromSec: 210,
                            toSec: 213,
                        },
                    ],
                },
            ],
            samples,
        })[0]!.match
    ).toMatchObject({ quality: "unknown", reason: "too quiet", candidates: [] });
});

test("items-add accepts a shared evidence group and its answer improves an unasked range", async () => {
    const fx = await fixture([]);
    const transcript = [
        { startSec: 10, speaker: "Voice", text: "This is the first substantial stretch with many words." },
        { startSec: 20, speaker: "Voice", text: "A shorter related stretch." },
    ];
    const journal = new DecisionJournal({
        store: fx.store,
        split: { transcript: async () => transcript },
        ledger: () => {},
    });
    await journal.apply({
        meeting: fx.meeting.id,
        actor: person,
        action: {
            kind: "add",
            findings: [
                {
                    ref: "first",
                    kind: "speaker-range",
                    from: 10,
                    to: 10,
                    label: "Voice",
                    speaker: "Bob Example",
                    candidates: ["Alice Example", "Bob Example"],
                    signature: "pair",
                    confidence: 0.55,
                    reason: "shared channel fixture",
                },
                {
                    kind: "speaker-range",
                    from: 20,
                    to: 20,
                    label: "Voice",
                    speaker: "Bob Example",
                    candidates: ["Alice Example", "Bob Example"],
                    signature: "pair",
                    confidence: 0.55,
                    reason: "shared channel fixture",
                },
                {
                    kind: "question",
                    about: "speaker",
                    from: 10,
                    to: 10,
                    question: "Who speaks?",
                    choices: ["Alice Example", "Bob Example"],
                    signature: "pair",
                    decides: ["first"],
                },
            ],
        },
    });
    await journal.apply({
        meeting: fx.meeting.id,
        actor: person,
        action: { kind: "answer", question: "i3", answer: "Alice Example" },
    });
    expect(
        new MeetingStore(fx.store.storage).read(fx.meeting.id)!.items.find((item) => item.id === "i2")
    ).toMatchObject({ status: "suggested", speaker: "Alice Example", confidence: 0.85 });
});

test("shared-call unknown ranges retain remote candidates only inside their stays and never name a person", () => {
    const record = meetingRecordSchema.parse({
        id: "shared",
        title: "",
        start: now,
        createdAt: now,
        createdBy: "new",
        participants: [
            { name: "Bob Example", from: ["user"] },
            {
                name: "Carol Example",
                firstSeenSec: 600,
                stays: [{ fromSec: 600, toSec: 2400, source: "hand", confidence: 1 }],
                from: ["user"],
            },
        ],
        seats: { room: [], remote: [{ name: "Bob Example" }, { name: "Carol Example", fromSec: 600, toSec: 2400 }] },
    });
    const lines = lineEvidence(
        [
            { startSec: 700, speaker: "Bob Example", text: "An uncertain call turn with unreadable indicator." },
            { startSec: 2500, speaker: "Bob Example", text: "The other person has left." },
        ],
        { speaking: [], segments: [{ startSec: 0, endSec: 3000, channel: "system", liveName: "Bob Example" }] }
    );
    const ranges = uncertainSharedCallRanges({ record, lines });
    expect(ranges).toHaveLength(1);
    expect(ranges[0]).toMatchObject({
        fromSec: 700,
        toSec: 700,
        candidates: ["Bob Example", "Carol Example"],
        evidence: { sharedCallUnknown: true },
    });
    expect(ranges[0]!.speaker).toBeUndefined();
});

test("the terminal clip bar keeps the asked forty-to-sixty percent span as its play head moves", () => {
    const plan = { duration: 10, askedFrom: 4, askedTo: 6, tone: 1, width: 50 };
    const first = clipProgress({ ...plan, position: 2.5 });
    const later = clipProgress({ ...plan, position: 7.5 });
    expect(first.length).toBeLessThanOrEqual(80);
    expect(first.slice(20, 31)).toBe("━".repeat(11));
    expect(later.slice(20, 31)).toBe(first.slice(20, 31));
    expect(first.indexOf("┃")).toBe(12);
    expect(later.indexOf("┃")).toBe(37);
    expect(first.indexOf("♪")).toBe(5);
});

test("voice source indices survive an earlier multi-voice transcript expansion", () => {
    const record = meetingRecordSchema.parse({
        id: "voice-indices",
        title: "",
        start: now,
        createdAt: now,
        createdBy: "new",
        items: [
            {
                id: "i1",
                kind: "speaker-range",
                label: "Voice",
                fromSec: 10,
                toSec: 10,
                status: "confirmed",
                voices: ["Alice Example", "Bob Example"],
                segments: [
                    { fromWord: 0, speaker: "Alice Example" },
                    { fromWord: 2, speaker: "Bob Example" },
                ],
                rules: [],
                suggestedAt: now,
            },
        ],
        evidence: {
            voice: {
                version: 1,
                source: "/fixture.wav",
                enrolment: "/fixture.json",
                lines: { "1": { model: "fixture", quality: "unknown", candidates: [], reason: "short" } },
            },
        },
    });
    const rendered = correctTranscript({
        record,
        transcript: [
            { startSec: 10, speaker: "Voice", text: "First sentence. Second sentence." },
            { startSec: 20, speaker: "Voice", text: "Another sentence." },
        ],
        config: meetingsConfigSchema.parse({}),
        format: "json",
    });
    expect(rendered.entries).toHaveLength(3);
    expect(rendered.entries[2]).toMatchObject({ startSec: 20, sourceIndex: 1 });
});

test("a forty-line question leads and its answer raises the compatible five-line stretch after reopen", async () => {
    const { suggestItems } = await import("./suggest");
    const { openQuestions } = await import("./questions");
    const ranges = [
        { id: "i1", fromSec: 0, toSec: 39, label: "Voice", speaker: "Alice Example" },
        { id: "i2", fromSec: 100, toSec: 104, label: "Voice", speaker: "Alice Example" },
        { id: "i3", fromSec: 200, toSec: 200, label: "Other", speaker: "Dan Example" },
    ];
    const entries = [
        ...Array.from({ length: 40 }, (_, index) => ({ startSec: index, speaker: "Voice" })),
        ...Array.from({ length: 5 }, (_, index) => ({ startSec: index + 100, speaker: "Voice" })),
        { startSec: 200, speaker: "Other" },
    ].map((entry) => ({ ...entry, text: "We will prepare the design document for the next meeting." }));
    const fx = await fixture(
        ranges.map((range) => ({
            ...range,
            kind: "speaker-range",
            status: "suggested",
            confidence: 0.5,
            rules: [],
            suggestedAt: now,
        }))
    );
    await fx.store.update(fx.meeting.id, { command: "test", change: "rank the unasked ranges" }, (record) => {
        record.participants = [
            { name: "Alice Example", from: ["hand"] },
            { name: "Bob Example", from: ["hand"] },
        ];
        record.items.push(
            ...suggestItems({
                record,
                meeting: {
                    sourceMeetingId: "fixture",
                    title: "Harbor sync",
                    start: record.start,
                    folders: [],
                    speakers: [],
                    participants: record.participants,
                    transcript: entries,
                },
                rules: [],
                dictionary: { entries: [], abbrExpansion: "every" },
                sourceWords: [],
                listenBelow: 0.6,
                questionBudget: 1,
                minPriority: 0,
                now,
            })
        );
    });
    const before = new MeetingStore(fx.store.storage).read(fx.meeting.id)!;
    const first = openQuestions(before)[0]!;
    expect(first.decides).toEqual(["i1"]);
    await fx.journal.apply({
        meeting: fx.meeting.id,
        actor: person,
        action: { kind: "answer", question: first.id, answer: "Bob Example" },
    });
    const after = new MeetingStore(fx.store.storage).read(fx.meeting.id)!;
    expect(after.items.find((item) => item.id === "i2")).toMatchObject({
        speaker: "Bob Example",
        confidence: 0.8,
        evidence: { propagatedFrom: first.id },
    });
    expect(after.items.find((item) => item.id === "i3")).toEqual(before.items.find((item) => item.id === "i3"));
});

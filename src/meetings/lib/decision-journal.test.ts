import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { meetingsConfigSchema } from "@genesiscz/utils/meetings/config";
import type { Correction } from "@genesiscz/utils/meetings/corrections";
import {
    type MeetingItem,
    type MeetingRecord,
    MeetingStore,
    meetingRecordSchema,
} from "@genesiscz/utils/meetings/record";
import { Storage } from "@genesiscz/utils/storage/storage";
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
} from "./decision-journal";
import { reviewRow } from "./review-rows";
import { assignmentReach } from "./speaker-assign";
import { correctTranscript } from "./transcript-corrections";

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
    });
});

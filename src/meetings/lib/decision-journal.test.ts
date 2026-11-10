import { describe, expect, spyOn, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Correction } from "@genesiscz/utils/meetings/corrections";
import { type MeetingItem, MeetingStore } from "@genesiscz/utils/meetings/record";
import * as atomicFile from "@genesiscz/utils/storage/atomic-file";
import { Storage } from "@genesiscz/utils/storage/storage";
import { ANSWER_LOG_FILE, readAnswerEvents } from "./answer-log";
import { actorOf, actorText, callerActor, DecisionJournal, JOURNAL_FILE } from "./decision-journal";

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
        expect(actorText(agent)).toBe("agent codex (session 1234abcd)");
        expect(actorText({ kind: "window" })).toBe("you in the window");
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

        rmSync(fx.journal.path(fx.meeting.id), { recursive: true });
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
});

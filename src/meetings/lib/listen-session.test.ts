import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Correction } from "@genesiscz/utils/meetings/corrections";
import { type MeetingItem, type MeetingRecord, MeetingStore } from "@genesiscz/utils/meetings/record";
import { Storage } from "@genesiscz/utils/storage/storage";
import type { TranscriptEntry } from "@genesiscz/utils/transcribe/types";
import { ANSWER_LOG_FILE, readAnswerEvents } from "./answer-log";
import { findingItems, findingsFileSchema } from "./findings";
import {
    type AskedQuestion,
    type ListenAdapter,
    type ListenOutcome,
    ListenSession,
    type SessionNote,
} from "./listen-session";
import { GivenAnswerAdapter } from "./listen-session-answer";
import { askedSpotSec, heardClip, type QuestionItem, questionView, questionWarnings } from "./questions";

const now = "2026-11-02T15:00:00.000Z";
let stores = 0;

type Scripted = ListenOutcome | ((asked: AskedQuestion) => Promise<ListenOutcome>);

/** Answers from a script, one entry per asked question; an empty script stops. */
class ScriptedAdapter implements ListenAdapter {
    readonly asked: AskedQuestion[] = [];
    readonly notes: SessionNote[] = [];

    constructor(
        private readonly script: Scripted[],
        private readonly leave = true
    ) {}

    async ask(asked: AskedQuestion): Promise<ListenOutcome> {
        this.asked.push(asked);
        const next = this.script.shift();

        if (next === undefined) {
            return "stop";
        }

        return typeof next === "function" ? await next(asked) : next;
    }

    async confirmLeave(): Promise<boolean> {
        return this.leave;
    }

    note(note: SessionNote): void {
        this.notes.push(note);
    }
}

function question(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id,
        kind: "question",
        status: "suggested",
        about: "speaker",
        fromSec: 10,
        toSec: 20,
        question: `Who speaks (${id})?`,
        choices: ["Alice Example", "Bob Example"],
        decides: [],
        rules: [],
        suggestedAt: now,
        ...extra,
    };
}

function term(id: string, atSec: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { id, kind: "term", status: "suggested", atSec, heard: "Ada", rules: [], suggestedAt: now, ...extra };
}

const transcript: TranscriptEntry[] = [
    { speaker: "A", startSec: 10, text: "první" },
    { speaker: "B", startSec: 12, text: "druhá" },
    { speaker: "A", startSec: 20, text: "po" },
];

async function fixture(items: Record<string, unknown>[]) {
    stores += 1;
    const store = new MeetingStore(new Storage(`meetings-session-${stores}`));
    const meeting = await store.create(
        { title: "Planning", start: "2026-11-02T14:00:00.000Z", createdBy: "new", items: items as MeetingItem[] },
        { command: "test", change: "fixture" }
    );
    const logPath = join(store.folder(meeting.id), ANSWER_LOG_FILE);
    const ledger: Correction[] = [];
    const session = (adapter: ListenAdapter, extra: { only?: string; budget?: number; join?: boolean } = {}) =>
        new ListenSession({
            store,
            meeting,
            logPath,
            adapter,
            ...(extra.only ? { only: extra.only } : {}),
            budget: extra.budget ?? 10,
            minPriority: 0,
            listenBelow: 0.6,
            ...(extra.join ? { joinRunningRound: true } : {}),
            split: { transcript: async () => transcript },
            ledger: (corrections) => ledger.push(...corrections),
        });
    const read = (): MeetingRecord => store.read(meeting.id)!;
    const item = (id: string) => read().items.find((entry) => entry.id === id);
    const events = () => readAnswerEvents(logPath).map((event) => event.event);
    return { store, meeting, logPath, ledger, session, read, item, events };
}

describe("listen session", () => {
    test("an adapter failure records an aborted round and preserves the error", async () => {
        const { session, logPath } = await fixture([question("i1")]);
        const error = new Error("clip unavailable");
        const adapter = new ScriptedAdapter([
            async () => {
                throw error;
            },
        ]);
        await expect(session(adapter).run()).rejects.toBe(error);
        expect(readAnswerEvents(logPath).at(-1)).toMatchObject({ event: "round-end", reason: "aborted" });
        expect(adapter.notes.at(-1)).toMatchObject({ kind: "ended", reason: "aborted" });
    });

    test("an answer decides its items, and a word answer settles the other question on the same heard words", async () => {
        const { session, item, ledger, logPath } = await fixture([
            term("i1", 50, { proposed: "ADA" }),
            term("i2", 70, { proposed: "ADA" }),
            question("i3", { about: "term", heard: "Ada", fromSec: 50, toSec: 54, decides: ["i1"] }),
            question("i4", { about: "term", heard: "ada", fromSec: 70, toSec: 74, decides: ["i2"] }),
        ]);
        const adapter = new ScriptedAdapter([{ answer: "ADO" }]);

        expect(await session(adapter).run()).toBe("done");
        expect(adapter.asked.map((asked) => asked.label)).toEqual(["Q1"]);
        expect(item("i4")).toMatchObject({
            status: "confirmed",
            answer: "ADO",
            comment: "settled by the answer to i3",
        });
        expect(item("i2")).toMatchObject({ status: "confirmed", proposed: "ADO" });
        expect(ledger.map((entry) => [entry.item, entry.fixed])).toEqual([
            ["i1", "ADO"],
            ["i2", "ADO"],
        ]);
        expect(readAnswerEvents(logPath)).toEqual([
            expect.objectContaining({ event: "round-start", open: 2 }),
            expect.objectContaining({ event: "answered", item: "i3", answer: "ADO", settled: ["i4"] }),
            expect.objectContaining({ event: "round-end", reason: "done", asked: 1, open: 0 }),
        ]);
        expect(adapter.notes[0]).toEqual({
            kind: "decided",
            label: "Q1",
            outcome: { answer: "ADO" },
            settled: ["Q2"],
        });
    });

    test("Esc undoes only what the answer changed: an items add made during the round stays", async () => {
        const fx = await fixture([
            {
                id: "i1",
                kind: "speaker-range",
                status: "suggested",
                label: "S5",
                fromSec: 10,
                toSec: 12,
                rules: [],
                suggestedAt: now,
                speaker: "Bob Example",
            },
            question("i2", { decides: ["i1"], priority: 2 }),
            question("i3", { fromSec: 40, toSec: 50, priority: 1 }),
        ]);
        const addDuringRound = async (): Promise<ListenOutcome> => {
            await fx.store.update(fx.meeting.id, { command: "items add", change: "1 findings" }, (current) => {
                current.items.push(term("i4", 90, { proposed: "ADO" }) as MeetingItem);
            });
            return "back";
        };
        const adapter = new ScriptedAdapter([{ answer: "Alice Example" }, addDuringRound, "stop"]);

        expect(await fx.session(adapter).run()).toBe("stopped");
        expect(adapter.asked.map((asked) => asked.question.id)).toEqual(["i2", "i3", "i2"]);
        expect(fx.item("i4")).toMatchObject({ kind: "term", status: "suggested" });
        expect(fx.item("i1")).toMatchObject({ status: "suggested", speaker: "Bob Example" });
        expect(fx.item("i1")?.decidedAt).toBeUndefined();
        expect(fx.item("i2")).toMatchObject({ status: "suggested" });
        expect(fx.item("i2")).not.toHaveProperty("answer");
        expect(fx.events()).toEqual(["round-start", "answered", "reopened", "round-end"]);
        expect(fx.ledger).toEqual([]);
    });

    test("Esc on the first question asks to leave; staying asks it again", async () => {
        const fx = await fixture([question("i1")]);
        const adapter = new ScriptedAdapter(["back", "skip"], false);

        expect(await fx.session(adapter).run()).toBe("done");
        expect(adapter.asked.map((asked) => asked.question.id)).toEqual(["i1", "i1"]);
        expect(fx.item("i1")).toMatchObject({ status: "rejected" });
    });

    test("--item with Several voices asks the parts and nothing else, each as unit 1 of 1", async () => {
        const fx = await fixture([question("i1"), question("i2", { fromSec: 40, toSec: 50, priority: 5 })]);
        const adapter = new ScriptedAdapter(["split", { answer: "Alice Example" }, { answer: "Bob Example" }]);

        expect(await fx.session(adapter, { only: "i1" }).run()).toBe("done");
        expect(adapter.asked.map((asked) => [asked.label, asked.position, asked.total, asked.part])).toEqual([
            ["Q1", 1, 1, undefined],
            ["Q3", 1, 1, { n: 1, of: 2 }],
            ["Q4", 1, 1, { n: 2, of: 2 }],
        ]);
        expect(fx.item("i2")).toMatchObject({ status: "suggested" });
        expect(fx.events()).toEqual(["round-start", "split", "answered", "answered", "round-end"]);
    });

    test("a split uses no budget: its parts share their parent's unit, and the next question waits for the next round", async () => {
        const fx = await fixture([
            question("i1", { priority: 5 }),
            question("i2", { fromSec: 40, toSec: 50, priority: 1 }),
        ]);
        const adapter = new ScriptedAdapter(["split", { answer: "Alice Example" }, { answer: "Bob Example" }]);

        expect(await fx.session(adapter, { budget: 1 }).run()).toBe("budget");
        expect(adapter.asked.map((asked) => asked.question.id)).toEqual(["i1", "i3", "i4"]);
        expect(adapter.asked.every((asked) => asked.position === 1 && asked.total === 1)).toBe(true);
        expect(readAnswerEvents(fx.logPath).at(-1)).toMatchObject({ event: "round-end", reason: "budget", asked: 2 });
    });

    test("Esc after a split's part undoes the part, then the split", async () => {
        const fx = await fixture([question("i1")]);
        const adapter = new ScriptedAdapter(["split", { answer: "Alice Example" }, "back", "back", "stop"]);

        await fx.session(adapter).run();
        expect(adapter.asked.map((asked) => asked.question.id)).toEqual(["i1", "i2", "i3", "i2", "i1"]);
        expect(fx.read().items.map((entry) => [entry.id, entry.status])).toEqual([["i1", "suggested"]]);
    });

    test("a join confirmed through a question writes its ledger line", async () => {
        const fx = await fixture([
            {
                id: "i1",
                kind: "join",
                status: "suggested",
                atSec: 30,
                joined: "databáze",
                rules: [],
                suggestedAt: now,
                evidence: { left: "data", right: "báze" },
            },
            question("i2", { decides: ["i1"] }),
        ]);

        await fx.session(new ScriptedAdapter([{ answer: "Alice Example" }])).run();
        expect(fx.ledger).toEqual([
            expect.objectContaining({ kind: "join", heard: "data báze", fixed: "databáze", item: "i1" }),
        ]);
    });

    test("the --answer adapter answers its one question, with no audio, in a round of its own", async () => {
        const fx = await fixture([question("i1"), question("i2")]);
        const printed: string[] = [];
        const adapter = new GivenAnswerAdapter({ answer: "Bob Example", comment: "clear" }, (line) =>
            printed.push(line)
        );

        expect(await fx.session(adapter, { only: "i2", budget: 1, join: true }).run()).toBe("done");
        expect(fx.item("i2")).toMatchObject({ status: "confirmed", answer: "Bob Example", comment: "clear" });
        expect(fx.item("i1")).toMatchObject({ status: "suggested" });
        expect(printed).toEqual(["Q2 answered: Bob Example"]);
        expect(fx.events()).toEqual(["round-start", "answered", "round-end"]);
    });
});

describe("question warnings at items add", () => {
    test("a twin of an open question, a question deciding nothing, and a missing priority", async () => {
        const fx = await fixture([
            question("i1", { question: "Who speaks here?", decides: ["i1"], priority: 1 }),
            question("i2", { question: "who speaks here? " }),
        ]);
        const record = fx.read();

        expect(questionWarnings(record, [record.items[1]!])).toEqual([
            expect.stringContaining("Q2 asks the same as Q1"),
            expect.stringContaining("Q2 decides no item"),
            expect.stringContaining("Q2 has no priority"),
        ]);
    });
});

function asQuestion(item: MeetingItem | undefined): QuestionItem {
    if (item?.kind !== "question") {
        throw new Error("not a question");
    }

    return item;
}

describe("a word question finds its own occurrence of the heard words", () => {
    const words: TranscriptEntry[] = [
        { speaker: "A", startSec: 50, text: "Dej to do Ada a pak taky do Ada, ne do zadání." },
        { speaker: "B", startSec: 60, text: "Jo." },
    ];

    test("two questions on one word in one line get their own spot and context; Ada is never inside zadání", async () => {
        const fx = await fixture([
            question("i1", { about: "term", heard: "Ada", fromSec: 50, toSec: 54 }),
            question("i2", { about: "term", heard: "Ada", fromSec: 50, toSec: 54 }),
        ]);
        const record = fx.read();
        const [first, second] = [
            questionView(record, asQuestion(record.items[0]), words, 240),
            questionView(record, asQuestion(record.items[1]), words, 240),
        ];

        expect(first.context?.lead).toBe("Dej to do ");
        expect(second.context?.lead).toBe("Dej to do Ada a pak taky do ");
        expect(second.context?.rest).toBe(", ne do zadání.");
    });

    test("the clip covers the late occurrence's spot, not the first 4 s of the line", async () => {
        const fx = await fixture([question("i1", { about: "term", heard: "zadání", fromSec: 50, toSec: 54 })]);
        const asked = asQuestion(fx.read().items[0]);
        const spot = askedSpotSec(asked, words);
        const clip = heardClip(asked, words)!;

        expect(spot).toBeGreaterThan(57);
        expect(clip.fromSec).toBeLessThan(spot);
        expect(clip.toSec).toBeGreaterThan(spot);
    });

    test("a question finding keeps its priority, on the scale suggest scores its own questions", () => {
        const parsed = findingsFileSchema.parse([
            { kind: "question", from: 10, to: 20, question: "Who?", priority: 6 },
        ]);
        expect(findingItems(parsed, [], now)[0]).toMatchObject({ kind: "question", priority: 6 });
    });
});

test("failed undo preserves the confirmed decision's ledger entry", async () => {
    const fx = await fixture([
        term("i1", 10, { proposed: "ADA" }),
        question("i2", { about: "term", heard: "Ada", decides: ["i1"], priority: 2 }),
        question("i3", { fromSec: 50, priority: 1 }),
    ]);
    const adapter = new ScriptedAdapter([
        { answer: "ADA" },
        async () => {
            fx.store.update = async () => {
                throw new Error("undo write failed");
            };
            return "back";
        },
    ]);
    await expect(fx.session(adapter).run()).rejects.toThrow("undo write failed");
    expect(fx.item("i1")?.status).toBe("confirmed");
    expect(fx.ledger).toContainEqual(expect.objectContaining({ item: "i1", fixed: "ADA" }));
});

test("a stale terminal decision preserves an answer submitted while it waited", async () => {
    for (const stale of ["skip", { answer: "Alice Example" }] as const) {
        const f = await fixture([question("i1")]);
        const adapter = new ScriptedAdapter([
            async () => {
                await f.store.update(f.meeting.id, { command: "test", change: "concurrent answer" }, (current) => {
                    const item = current.items[0];
                    if (item.kind === "question") {
                        item.status = "confirmed";
                        item.answer = "Bob Example";
                    }
                });
                return stale;
            },
        ]);
        await f.session(adapter).run();
        expect(f.item("i1")).toMatchObject({ status: "confirmed", answer: "Bob Example" });
        expect(f.events()).not.toContain("answered");
        expect(f.events()).not.toContain("skipped");
    }
});

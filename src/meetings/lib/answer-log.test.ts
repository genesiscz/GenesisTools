import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { type MeetingItem, MeetingStore } from "@genesiscz/utils/meetings/record";
import { Storage } from "@genesiscz/utils/storage/storage";
import {
    ANSWER_LOG_FILE,
    type AnswerEvent,
    appendAnswerEvent,
    readAnswerEvents,
    runningRound,
    subscribeAnswers,
} from "./answer-log";
import { DecisionJournal } from "./decision-journal";
import { askedSpotSec, type QuestionItem } from "./questions";

const at = "2026-01-01T10:00:00.000Z";

function logFile(events: AnswerEvent[]): string {
    const path = join(mkdtempSync(join(tmpdir(), "answer-log-")), "questions.ndjson");

    for (const event of events) {
        appendAnswerEvent(path, event);
    }

    return path;
}

const answered = (item: string, answer: string): AnswerEvent => ({
    event: "answered",
    at,
    item,
    about: "term",
    fromSec: 10,
    toSec: 14,
    question: "What is said?",
    answer,
    settled: [],
});

describe("answer log", () => {
    test("the running round is the events from the last round-start without a round-end after it", () => {
        const events: AnswerEvent[] = [
            { event: "round-start", at, pid: 1, open: 2 },
            answered("i1", "alpha"),
            { event: "round-end", at, reason: "stopped", asked: 1, open: 1 },
            { event: "round-start", at, pid: 2, open: 1 },
            answered("i2", "beta"),
        ];

        expect(runningRound(events).map((event) => event.event)).toEqual(["round-start", "answered"]);
        expect(runningRound(events.slice(0, 3))).toEqual([]);
    });

    test("a subscriber prints the running round first, then each new answer, and ends with the round", async () => {
        const path = logFile([{ event: "round-start", at, pid: process.pid, open: 2 }, answered("i1", "alpha")]);
        const lines: string[] = [];
        const done = subscribeAnswers({ path, fromStart: false, timeoutMs: 5000, write: (line) => lines.push(line) });
        await Bun.sleep(50);
        appendAnswerEvent(path, answered("i2", "beta"));
        appendAnswerEvent(path, { event: "round-end", at, reason: "done", asked: 2, open: 0 });

        expect(await done).toBe(0);
        expect(lines.map((line) => SafeJSON.parse(line, { jsonl: true }).event)).toEqual([
            "round-start",
            "answered",
            "answered",
            "round-end",
        ]);
        expect(readAnswerEvents(path)).toHaveLength(4);
    });

    test("events appended during backlog replay are delivered exactly once", async () => {
        const path = logFile([{ event: "round-start", at, pid: process.pid, open: 1 }]);
        const events: string[] = [];
        const code = await subscribeAnswers({
            path,
            fromStart: false,
            timeoutMs: 1000,
            write: (line) => {
                const event = SafeJSON.parse(line, { jsonl: true }).event;
                events.push(event);
                if (event === "round-start") {
                    appendAnswerEvent(path, answered("i1", "beta"));
                    appendAnswerEvent(path, { event: "round-end", at, reason: "done", asked: 1, open: 0 });
                }
            },
        });

        expect(code).toBe(0);
        expect(events).toEqual(["round-start", "answered", "round-end"]);
    });

    test("a listener that is gone without a round-end is reported as an aborted round", async () => {
        const path = logFile([{ event: "round-start", at, pid: 424242, open: 1 }]);
        const lines: string[] = [];
        const code = await subscribeAnswers({
            path,
            fromStart: false,
            timeoutMs: 5000,
            write: (line) => lines.push(line),
            alive: () => false,
            livenessMs: 20,
        });

        expect(code).toBe(0);
        expect(SafeJSON.parse(lines.at(-1)!, { jsonl: true })).toMatchObject({ event: "round-end", reason: "aborted" });
    });

    test("--follow stays up across one-question rounds and ends when a round leaves no open question", async () => {
        const path = logFile([{ event: "round-start", at, pid: process.pid, open: 1 }]);
        const events: string[] = [];
        const next: AnswerEvent[][] = [
            [answered("i1", "alpha"), { event: "round-end", at, reason: "done", asked: 1, open: 1 }],
            [{ event: "round-start", at, pid: process.pid, open: 1 }],
            [answered("i2", "beta"), { event: "round-end", at, reason: "done", asked: 1, open: 0 }],
        ];
        const code = await subscribeAnswers({
            path,
            fromStart: false,
            timeoutMs: 5000,
            follow: true,
            write: (line) => {
                const event = SafeJSON.parse(line, { jsonl: true }).event;
                events.push(event);
                if (event === "round-start" || (event === "round-end" && next.length > 0)) {
                    for (const later of next.shift() ?? []) {
                        appendAnswerEvent(path, later);
                    }
                }
            },
        });

        expect(code).toBe(0);
        expect(events).toEqual(["round-start", "answered", "round-end", "round-start", "answered", "round-end"]);
    });

    test("--follow outlives a listener that died without its round-end, until the deadline", async () => {
        const path = logFile([{ event: "round-start", at, pid: 424242, open: 2 }]);
        const lines: string[] = [];
        const code = await subscribeAnswers({
            path,
            fromStart: false,
            timeoutMs: 200,
            follow: true,
            write: (line) => lines.push(line),
            alive: () => false,
            livenessMs: 20,
        });

        expect(code).toBe(2);
        expect(lines.map((line) => SafeJSON.parse(line, { jsonl: true }).event)).toEqual(["round-start", "round-end"]);
    });

    test("no round ending before the timeout exits 2", async () => {
        const path = logFile([]);
        const code = await subscribeAnswers({ path, fromStart: false, timeoutMs: 60, write: () => undefined });

        expect(code).toBe(2);
    });

    // The decision journal writes the answer log's decision lines now: the keys --subscribe-answers prints, in their
    // order, stay as listen-session wrote them (new keys may be added, none removed or renamed).
    test("the journal's answered and reopened lines keep the --subscribe-answers shape", async () => {
        const store = new MeetingStore(new Storage(`meetings-answer-log-${process.pid}`));
        const items = [
            {
                id: "i1",
                kind: "term",
                status: "suggested",
                atSec: 50,
                heard: "Ada",
                proposed: "ADA",
                rules: [],
                suggestedAt: at,
            },
            {
                id: "i2",
                kind: "question",
                status: "suggested",
                about: "term",
                heard: "Ada",
                fromSec: 50,
                toSec: 54,
                question: "Which word?",
                choices: ["ADA", "ADO"],
                decides: ["i1"],
                rules: [],
                suggestedAt: at,
            },
        ] as MeetingItem[];
        const meeting = await store.create(
            { title: "Harbor sync", start: at, createdBy: "new", items },
            { command: "test", change: "fixture" }
        );
        const journal = new DecisionJournal({ store, ledger: () => undefined });
        const { entry } = await journal.apply({
            meeting: meeting.id,
            action: { kind: "answer", question: "i2", answer: "ADO", comment: "clear" },
            actor: { kind: "listen" },
        });
        await journal.revert({ meeting: meeting.id, token: entry!.token, actor: { kind: "listen" } });
        const lines = readAnswerEvents(join(store.folder(meeting.id), ANSWER_LOG_FILE));

        expect(lines.map((line) => Object.keys(line))).toEqual([
            [
                "event",
                "at",
                "item",
                "about",
                "fromSec",
                "toSec",
                "question",
                "heard",
                "answer",
                "comment",
                "settled",
                "decided",
            ],
            ["event", "at", "item"],
        ]);
        expect(lines[0]).toMatchObject({ item: "i2", answer: "ADO", decided: [{ item: "i1", status: "confirmed" }] });
    });
});

describe("askedSpotSec", () => {
    const question = (overrides: { about?: QuestionItem["about"]; heard?: string }): QuestionItem => ({
        id: "i1",
        kind: "question",
        status: "suggested",
        about: "term",
        fromSec: 20,
        toSec: 30,
        question: "What is said?",
        choices: [],
        decides: [],
        rules: [],
        suggestedAt: at,
        ...overrides,
    });
    const transcript = [
        { speaker: "A", startSec: 20, text: "one two three four five six seven eight nine ten" },
        { speaker: "B", startSec: 30, text: "next" },
    ];

    test("a term's heard words fall where their place in the line puts them", () => {
        const spot = askedSpotSec(question({ heard: "six" }), transcript);

        expect(spot).toBeGreaterThan(24);
        expect(spot).toBeLessThan(26);
    });

    test("a speaker range, or words not in the line, starts at the range", () => {
        expect(askedSpotSec(question({ about: "speaker" }), transcript)).toBe(20);
        expect(askedSpotSec(question({ heard: "missing" }), transcript)).toBe(20);
    });
});

import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
import { commentStreamLines, MeetingComments } from "./comments";
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
    test("follow survives an empty round and reports its timeout", async () => {
        const path = logFile([{ event: "round-start", at, pid: process.pid, open: 1 }]);
        const events: string[] = [];
        const diagnostics: string[] = [];
        const result = subscribeAnswers({
            path,
            fromStart: false,
            timeoutMs: 150,
            follow: true,
            diagnostic: (line) => diagnostics.push(line),
            write: (line) => events.push(SafeJSON.parse(line).event),
        });
        appendAnswerEvent(path, { event: "questions-rejected", at, items: ["i1"], open: 0 });
        expect(await result).toBe(2);
        expect(events).toContain("round-ended");
        expect(diagnostics.join(" ")).toContain("timeout");
    });

    test("journal rejection of every question emits round-ended and follow observes the next round", async () => {
        const storage = new Storage(`reject-follow-${process.pid}`);
        const store = new MeetingStore(storage);
        const record = await store.create(
            {
                title: "Follow fixture",
                start: at,
                createdBy: "new",
                items: [
                    {
                        id: "i1",
                        kind: "question",
                        status: "suggested",
                        about: "speaker",
                        fromSec: 0,
                        toSec: 10,
                        question: "Who?",
                        choices: ["Alice", "Bob"],
                        decides: [],
                        rules: [],
                        suggestedAt: at,
                    },
                ],
            },
            { command: "test", change: "fixture" }
        );
        const path = join(store.folder(record.id), ANSWER_LOG_FILE);
        appendAnswerEvent(path, { event: "round-start", at, pid: process.pid, open: 1 });
        const events: string[] = [];
        const done = subscribeAnswers({
            path,
            fromStart: false,
            timeoutMs: 500,
            follow: true,
            diagnostic: () => undefined,
            write: (line) => {
                const event = SafeJSON.parse(line).event;
                events.push(event);
                if (event === "round-ended") {
                    appendAnswerEvent(path, { event: "round-start", at, pid: process.pid, open: 1 });
                    appendAnswerEvent(path, answered("i2", "Alice"));
                    appendAnswerEvent(path, { event: "round-end", at, reason: "done", asked: 1, open: 0 });
                }
            },
        });
        await new DecisionJournal({ store, ledger: () => undefined }).apply({
            meeting: record.id,
            action: { kind: "reject", items: ["i1"] },
            actor: { kind: "agent", harness: "fixture", session: null },
        });
        expect(await done).toBe(2);
        expect(events).toContain("questions-rejected");
        expect(events).toContain("round-ended");
        expect(events.indexOf("answered")).toBeGreaterThan(events.indexOf("round-ended"));
        expect(new MeetingStore(storage).read(record.id)?.items[0]?.status).toBe("rejected");
    });

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

    test("--follow stays up across empty rounds until the timeout", async () => {
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
            timeoutMs: 1500,
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

        expect(code).toBe(2);
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

    // A crash mid-append leaves a line with no line end: the readers pass over it, and the next event starts on a line
    // of its own instead of being glued onto it.
    test("a torn line is passed over: the round still reads, and the next event after it reads too", async () => {
        const path = logFile([{ event: "round-start", at, pid: process.pid, open: 2 }, answered("i1", "alpha")]);
        appendFileSync(path, '{"event":"answered","at":"2026-01-01T10:0');
        const lines: string[] = [];
        const done = subscribeAnswers({ path, fromStart: false, timeoutMs: 5000, write: (line) => lines.push(line) });
        await Bun.sleep(50);
        appendAnswerEvent(path, { event: "round-end", at, reason: "done", asked: 1, open: 1 });

        expect(await done).toBe(0);
        expect(lines.map((line) => SafeJSON.parse(line, { jsonl: true }).event)).toEqual([
            "round-start",
            "answered",
            "round-end",
        ]);
        expect(readAnswerEvents(path).map((event) => event.event)).toEqual(["round-start", "answered", "round-end"]);
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

describe("comments for the listening agent (comments.ndjson)", () => {
    const person = { kind: "window" } as const;
    const selection = {
        kind: "selection",
        from: { atSec: 62, line: 14 },
        to: { atSec: 66, line: 15, fraction: 0.5 },
    } as const;
    const commentsFile = (alive: (pid: number) => boolean = () => true) =>
        new MeetingComments(join(mkdtempSync(join(tmpdir(), "comments-")), "comments.ndjson"), {
            now: () => new Date(at),
            alive,
        });

    test("another writer cannot allocate a comment id during a staged transaction", () => {
        const first = commentsFile();
        const other = new MeetingComments(first.path);
        first.transaction(() => {
            expect(() => other.stage({ target: selection, text: "Contending writer", actor: person })).toThrow();
            expect(first.stage({ target: selection, text: "First writer", actor: person }).id).toBe("c1");
        });
        expect(other.stage({ target: selection, text: "Next writer", actor: person }).id).toBe("c2");
        expect(new MeetingComments(first.path).list().map((comment) => comment.id)).toEqual(["c1", "c2"]);
    });

    test("a new comment id stays above every kept id when an older staged line no longer reads", () => {
        const comments = commentsFile();
        comments.stage({ target: selection, text: "First", actor: person });
        comments.stage({ target: selection, text: "Second", actor: person });
        comments.markSent(comments.staged(["c2"]), { token: "t-1", at, actor: person });
        const text = readFileSync(comments.path, "utf8").replace('"id":"c1"', '"id":1');
        writeFileSync(comments.path, text);

        expect(comments.stage({ target: selection, text: "Third", actor: person }).id).toBe("c3");
        expect(comments.list().map((comment) => [comment.id, comment.state])).toEqual([
            ["c2", "sent"],
            ["c3", "staged"],
        ]);
    });

    test("staged comments stay until sent or unstaged; a sent one cannot change, and a torn line is passed over", () => {
        const comments = commentsFile();
        const first = comments.stage({ target: selection, text: "This is EMP, not OMP", quote: "OMP", actor: person });
        comments.stage({ target: { kind: "time", atSec: 90 }, text: "Ask about the budget", actor: person });
        comments.stage({ target: { kind: "time", atSec: 95 }, text: "Never mind", actor: person });
        comments.unstage("c3", person);
        appendFileSync(comments.path, '{"kind":"staged","comment":{"id":"c9"');
        const sent = comments.markSent(comments.staged(["c1"]), { token: "t-1", at, actor: person });

        expect(first).toEqual({
            id: "c1",
            at,
            target: selection,
            text: "This is EMP, not OMP",
            quote: "OMP",
            actor: person,
            state: "staged",
        });
        expect(sent.map((comment) => [comment.id, comment.state, comment.token])).toEqual([["c1", "sent", "t-1"]]);
        expect(comments.list().map((comment) => [comment.id, comment.state])).toEqual([
            ["c1", "sent"],
            ["c2", "staged"],
        ]);
        expect(comments.staged().map((comment) => comment.id)).toEqual(["c2"]);
        expect(() => comments.staged(["c1"])).toThrow("Comment c1 was sent at");
        expect(() => comments.unstage("c3", person)).toThrow("No staged comment c3.");
    });

    test("receipts come from another actor and only the author or the person can retract a comment", () => {
        const comments = commentsFile();
        const receiver = { kind: "agent", harness: "fixture", session: "receiver" } as const;
        const otherAgent = { ...receiver, session: "other" };
        comments.stage({ target: selection, text: "Person's comment", actor: person });
        comments.stage({ target: selection, text: "Agent's comment", actor: receiver });
        comments.markSent(comments.staged(), { token: "t-roles", at, actor: person });
        comments.stage({ target: selection, text: "Still staged", actor: person });
        const before = readFileSync(comments.path, "utf8");
        expect(() => comments.acknowledge("c1", person)).toThrow("author cannot acknowledge");
        expect(() => comments.acknowledge("c1", { kind: "cli" })).toThrow("author cannot acknowledge");
        expect(() => comments.acknowledge("c2", receiver)).toThrow("author cannot acknowledge");
        expect(() => comments.withdraw("c1", receiver)).toThrow("Only the author or the person");
        expect(() => comments.withdraw("c2", otherAgent)).toThrow("Only the author or the person");
        expect(() => comments.unstage("c3", receiver)).toThrow("Only the author or the person");
        expect(readFileSync(comments.path, "utf8")).toBe(before);
        expect(comments.acknowledge("c1", receiver).readBy).toEqual(receiver);
        expect(comments.withdraw("c2", receiver).withdrawnAt).toBe(at);
        expect(comments.unstage("c3", { kind: "cli" }).id).toBe("c3");
        const reopened = new MeetingComments(comments.path);
        expect(reopened.list()).toMatchObject([
            { id: "c1", readBy: receiver },
            { id: "c2", withdrawnAt: at },
        ]);
    });

    test("read receipts survive reopening and withdrawal wins until a receiver reads", () => {
        const comments = commentsFile();
        comments.stage({ target: selection, text: "First comment", actor: person });
        comments.stage({ target: selection, text: "Second comment", actor: person });
        comments.markSent(comments.staged(), { token: "t-read", at, actor: person });
        const other = new MeetingComments(comments.path, { now: () => new Date(at) });
        const receiver = { kind: "agent", harness: "fixture", session: "receiver" } as const;
        expect(other.acknowledge("c1", receiver)).toMatchObject({ readAt: at, readBy: receiver });
        expect(() => comments.withdraw("c1", person)).toThrow("was read");
        expect(other.withdraw("c2", person)).toMatchObject({ withdrawnAt: at });
        expect(() => comments.acknowledge("c2", person)).toThrow("was withdrawn");
        const reopened = new MeetingComments(comments.path);
        expect(reopened.list()).toMatchObject([
            { id: "c1", readAt: at },
            { id: "c2", withdrawnAt: at },
        ]);
        const withdrawal = reopened.lines().find((line) => line.kind === "withdrawn");
        expect(withdrawal && commentStreamLines(withdrawal)).toEqual([
            { type: "comment-withdrawn", event: "comment.withdrawn", id: "c2", at },
        ]);
    });

    test("a listener counts while it runs: until it leaves, or once its process is gone", () => {
        const running = new Set([101, 202]);
        const comments = commentsFile((pid) => running.has(pid));
        comments.join({ pid: 101, actor: { kind: "agent", harness: "claude-code", session: null } });
        comments.join({ pid: 202, actor: person });
        comments.join({ pid: 303, actor: person });
        comments.leave(202);

        expect(comments.listeners()).toEqual([
            { pid: 101, at, actor: { kind: "agent", harness: "claude-code", session: null } },
        ]);
    });

    test("--with-comments prints each sent comment as a typed line, and the answers with type answer", async () => {
        const comments = commentsFile();
        comments.stage({ target: selection, text: "Earlier comment", actor: person });
        comments.markSent(comments.staged(), { token: "t-0", at, actor: person });
        const path = logFile([{ event: "round-start", at, pid: process.pid, open: 1 }]);
        const lines: string[] = [];
        const following = comments.follow({ fromStart: false, write: (line) => lines.push(line) });
        const done = subscribeAnswers({
            path,
            fromStart: false,
            timeoutMs: 5000,
            write: (line) => lines.push(line),
            typed: true,
        });
        comments.stage({ target: selection, text: "This is EMP", quote: "OMP", actor: person });
        comments.markSent(comments.staged(), { token: "t-1", at, actor: person });
        await Bun.sleep(50);
        following.stop();
        appendAnswerEvent(path, { event: "round-end", at, reason: "done", asked: 0, open: 0 });

        expect(await done).toBe(0);
        expect(lines.map((line) => SafeJSON.parse(line, { jsonl: true }))).toEqual([
            { type: "answer", event: "round-start", at, pid: process.pid, open: 1 },
            {
                type: "comment",
                event: "comment",
                at,
                id: "c2",
                text: "This is EMP",
                quote: "OMP",
                target: selection,
                token: "t-1",
            },
            { type: "answer", event: "round-end", at, reason: "done", asked: 0, open: 0 },
        ]);
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

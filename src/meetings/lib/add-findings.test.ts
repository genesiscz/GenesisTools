import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { meetingsConfigSchema } from "@genesiscz/utils/meetings/config";
import { MeetingStore, meetingRecordSchema } from "@genesiscz/utils/meetings/record";
import { Storage } from "@genesiscz/utils/storage";
import { planFindings, prepareFindings } from "./add-findings";
import { DecisionJournal } from "./decision-journal";
import { findingsFileSchema } from "./findings";
import { decisionsFileSchema, findingsFromDecisions } from "./from-decisions";
import { personInitials } from "./person-initials";

const findings = findingsFileSchema.parse([
    { kind: "question", from: 0, to: 10, question: "Who speaks?", choices: ["Alice", "Bob"], decides: ["voice"] },
    {
        kind: "speaker-range",
        ref: "voice",
        from: 0,
        to: 10,
        label: "Speaker 1",
        speaker: "Alice",
        confidence: 0.8,
        reason: "voice evidence",
    },
]);
const transcript = [
    { startSec: 0, speaker: "Speaker 1", text: "Hello there" },
    { startSec: 5, speaker: "Speaker 2", text: "Other voice" },
    { startSec: 10, speaker: "Speaker 1", text: "Last words" },
];

describe("a line on a speaker range", () => {
    const wide = findingsFileSchema.parse([
        {
            kind: "speaker-range",
            from: 0,
            to: 10,
            label: "Speaker 1",
            speaker: "Alice",
            line: 2,
            confidence: 0.8,
            reason: "voice evidence",
        },
    ]);

    test("on a range wider than one second it still names every line of the label, and adding it warns", () => {
        const { added, warnings } = prepareFindings({ findings: wide, items: [], transcript });
        const warning = `${added[0]!.id}: "line": 2 names one line only when "from" and "to" are the same second; this range applies to every "Speaker 1" line from 00:00 to 00:10. To name one line, give "from" and "to" its second`;
        expect(warnings).toEqual([warning]);
        expect(prepareFindings({ findings: wide, items: [] }).warnings).toEqual([warning]);
        // The stored meaning stays: suggest keeps a stretch's first line on it, and the range reaches both lines.
        const record = meetingRecordSchema.parse({
            id: "2026-11-02_15-00-lines",
            title: "Lines",
            start: "2026-11-02T15:00:00.000Z",
            createdAt: "2026-11-02T15:00:00.000Z",
            createdBy: "new",
        });
        const plan = planFindings({ findings: wide, record, transcript, config: meetingsConfigSchema.parse({}) });
        expect(plan.findings[0]?.lines.map((line) => line.index)).toEqual([0, 2]);
    });

    test("on a range inside one second it names that line, with no warning", () => {
        const one = findingsFileSchema.parse([{ ...wide[0], from: 10, to: 10 }]);
        expect(prepareFindings({ findings: one, items: [], transcript }).warnings).toEqual([]);
    });
});

describe("a term fix against the screen", () => {
    test("adding a fix the screen near it spells otherwise warns with the screen line; a fix the screen shows does not", async () => {
        const store = new MeetingStore(new Storage("term-screen-fixture"));
        const start = Date.parse("2026-11-01T10:00:00Z");
        const saved = await store.create(
            { title: "Invented meeting", start: new Date(start).toISOString(), createdBy: "new" },
            { command: "fixture", change: "created" }
        );
        const folder = store.folder(saved.id);
        mkdirSync(join(folder, "frames"), { recursive: true });
        const row = {
            file: "frames/a.png",
            at: new Date(start + 70_000).toISOString(),
            displayId: 1,
            text: "ContentRows grid",
            blocks: [],
        };
        writeFileSync(join(folder, "ocr.jsonl"), `${SafeJSON.stringify(row)}\n`);
        const journal = new DecisionJournal({ store, ledger: () => {} });
        const term = (proposed: string) =>
            findingsFileSchema.parse([
                {
                    kind: "term",
                    at: "01:05",
                    heard: "content rouz",
                    proposed,
                    confidence: 0.8,
                    reason: "the component name",
                },
            ]);

        const wrong = await journal.apply({
            meeting: saved.id,
            action: { kind: "add", findings: term("ContentRoes") },
            actor: { kind: "listen" },
        });
        expect(wrong.warnings?.find((warning) => warning.includes("the screen at"))).toStartWith(
            'i1: the screen at 01:10 shows "ContentRows"'
        );

        const right = await journal.apply({
            meeting: saved.id,
            action: { kind: "add", findings: term("ContentRows") },
            actor: { kind: "listen" },
        });
        expect((right.warnings ?? []).some((warning) => warning.includes("the screen at"))).toBe(false);
    });
});

describe("idempotent findings", () => {
    test("full replay retains ids, including a forward ref, and mixed replay resolves new questions to retained ranges", () => {
        const first = prepareFindings({ findings, items: [], transcript });
        const retry = prepareFindings({ findings, items: first.added, transcript });
        expect(retry.added).toEqual([]);
        expect(retry.duplicates.map((item) => item.id)).toEqual(first.added.map((item) => item.id));
        const mixed = prepareFindings({
            findings: findingsFileSchema.parse([{ ...findings[0], question: "Another question?" }, findings[1]]),
            items: first.added,
            transcript,
        });
        expect(mixed.added).toHaveLength(1);
        expect(mixed.added[0]).toMatchObject({ kind: "question", decides: [first.added[1]!.id] });
        expect(prepareFindings({ findings, items: first.added, allowDuplicates: true }).added).toHaveLength(2);
        expect(
            prepareFindings({ findings, items: first.added.map((item) => ({ ...item, status: "confirmed" })) }).added
        ).toHaveLength(2);
        expect(
            prepareFindings({ findings, items: first.added.map((item) => ({ ...item, status: "rejected" })) }).added
        ).toHaveLength(2);
    });

    test("meaningful term fields and question choices remain distinct", () => {
        const terms = findingsFileSchema.parse([
            { kind: "term", at: 0, heard: "Hello", proposed: "Hallo", confidence: 0.8, reason: "spelling" },
        ]);
        const items = prepareFindings({ findings: terms, items: [], transcript }).added;
        for (const change of [
            { scope: "line" },
            { line: 2 },
            { proposed: "Welcome" },
            { meaning: "greeting" },
            { quote: { text: "Greetings", source: "Guide" } },
            { at: 10 },
            { confidence: 0.9 },
            { reason: "new evidence" },
        ]) {
            expect(
                prepareFindings({ findings: findingsFileSchema.parse([{ ...terms[0], ...change }]), items }).added
            ).toHaveLength(1);
        }
        const first = prepareFindings({ findings, items: [] });
        expect(
            prepareFindings({
                findings: findingsFileSchema.parse([
                    { ...findings[0], choices: ["Carol", "Bob"], decides: [first.added[1]!.id] },
                ]),
                items: first.added,
            }).added
        ).toHaveLength(1);
    });

    test("concurrent locked insertion persists once; replay and plan preserve bytes, mtime and history on reopen", async () => {
        const storage = new Storage("idempotent-findings-fixture");
        const store = new MeetingStore(storage);
        const saved = await store.create(
            { title: "Invented meeting", start: "2026-11-01T10:00:00Z", createdBy: "new" },
            { command: "fixture", change: "created" }
        );
        const journal = new DecisionJournal({ store, ledger: () => {} });
        const insert = () =>
            journal.apply({ meeting: saved.id, action: { kind: "add", findings }, actor: { kind: "listen" } });
        await Promise.all([insert(), insert()]);
        const reopened = new MeetingStore(storage).read(saved.id)!;
        expect(reopened.items).toHaveLength(2);
        expect(reopened.history).toHaveLength(2);
        expect(new DecisionJournal({ store: new MeetingStore(storage), ledger: () => {} }).read(saved.id)).toHaveLength(
            1
        );
        const journalFile = join(store.folder(saved.id), "decisions.ndjson");
        const journalBefore = readFileSync(journalFile);
        const journalMtime = statSync(journalFile).mtimeMs;
        const before = readFileSync(store.path(saved.id));
        const mtime = statSync(store.path(saved.id)).mtimeMs;
        await insert();
        const { planFindings } = await import("./add-findings");
        const plan = planFindings({ findings, record: reopened, transcript, config: meetingsConfigSchema.parse({}) });
        expect(plan.findings[1]!.lines.map((line) => line.index)).toEqual([0, 2]);
        expect(plan.findings[1]!.lines.map((line) => line.firstWords)).toEqual(["Hello there", "Last words"]);
        expect(plan.findings).toHaveLength(2);
        expect(plan.findings[0]!.lines.map((line) => line.index)).toEqual([0, 2]);
        expect(readFileSync(store.path(saved.id))).toEqual(before);
        expect(statSync(store.path(saved.id)).mtimeMs).toBe(mtime);
        expect(new MeetingStore(storage).read(saved.id)).toEqual(reopened);
        expect(readFileSync(journalFile)).toEqual(journalBefore);
        expect(statSync(journalFile).mtimeMs).toBe(journalMtime);
    });
});

test("CLI plan reads only a local transcript and preserves all durable fixture files", async () => {
    const { Command } = await import("commander");
    const { registerItemCommands } = await import("../commands/items");
    const source = await import("@app/wisprflow/lib/source");
    const store = new MeetingStore();
    const record = await store.create(
        {
            title: "Plan fixture",
            start: "2026-11-01T11:00:00Z",
            createdBy: "new",
            sources: { wisprflow: { meetingId: "invented-source" } },
        },
        { command: "fixture", change: "created" }
    );
    const folderBefore = readdirSync(store.folder(record.id));
    const before = readFileSync(store.path(record.id));
    const mtime = statSync(store.path(record.id)).mtimeMs;
    const load = spyOn(source, "loadMeeting").mockImplementation(async (_id, options) => {
        expect(options.source).toBe("local");
        return {
            source: "local",
            notes: [],
            data: {
                id: "invented-source",
                title: "Plan fixture",
                start: record.start,
                hasTranscript: true,
                folders: [],
                summary: "",
                notes: "",
                participants: [],
                transcript,
            },
        };
    });
    const output = spyOn(out, "result").mockImplementation(() => {});
    try {
        const program = new Command();
        registerItemCommands(program);
        await program.parseAsync(
            [
                "items",
                "add",
                record.id,
                "--plan",
                "--kind",
                "speaker-range",
                "--from",
                "0",
                "--to",
                "10",
                "--label",
                "Speaker 1",
                "--speaker",
                "Alice",
                "--confidence",
                "0.8",
                "--reason",
                "voice evidence",
            ],
            { from: "user" }
        );
        expect(load).toHaveBeenCalledTimes(1);
        expect(output.mock.calls[0]?.[0]).toMatchObject({
            findings: [
                {
                    kind: "speaker-range",
                    lines: [
                        { index: 0, firstWords: "Hello there" },
                        { index: 2, firstWords: "Last words" },
                    ],
                },
            ],
        });
        expect(readFileSync(store.path(record.id))).toEqual(before);
        expect(statSync(store.path(record.id)).mtimeMs).toBe(mtime);
        expect(readdirSync(store.folder(record.id))).toEqual(folderBefore);
        expect(new MeetingStore().read(record.id)).toEqual(record);
    } finally {
        output.mockRestore();
        load.mockRestore();
    }
});

test("plan uses shared term, join and label addresses", async () => {
    const { planFindings } = await import("./add-findings");
    const store = new MeetingStore(new Storage("plan-kinds-fixture"));
    const record = await store.create(
        { title: "Kinds fixture", start: "2026-11-01T12:00:00Z", createdBy: "new" },
        { command: "fixture", change: "created" }
    );
    const planned = planFindings({
        record,
        transcript,
        config: meetingsConfigSchema.parse({}),
        findings: findingsFileSchema.parse([
            {
                kind: "term",
                at: 0,
                heard: "Hello",
                proposed: "Hallo",
                scope: "line",
                confidence: 0.8,
                reason: "spelling",
            },
            { kind: "label", from: 0, to: 10, label: "Speaker 1", meaningless: true, reason: "mixed voices" },
        ]),
    });
    expect(planned.findings.map((finding) => finding.lines.map((line) => line.index))).toEqual([[0], [0, 2]]);
    const join = planFindings({
        record,
        transcript: [
            { startSec: 0, speaker: "Speaker 1", text: "Hel" },
            { startSec: 5, speaker: "Speaker 1", text: "lo there" },
        ],
        config: meetingsConfigSchema.parse({}),
        findings: findingsFileSchema.parse([
            { kind: "join", at: 5, joined: "Hello", confidence: 0.8, reason: "cut word" },
        ]),
    });
    expect(join.findings[0]!.lines.map((line) => line.index)).toEqual([0, 1]);
});

test("plan shows a question that changes no line as stored on the lines of its range, as add stores it", async () => {
    const { planFindings } = await import("./add-findings");
    const record = meetingRecordSchema.parse({
        id: "2026-11-02_15-00-asked",
        title: "Asked",
        start: "2026-11-02T15:00:00.000Z",
        createdAt: "2026-11-02T15:00:00.000Z",
        createdBy: "new",
    });
    const plan = (finding: Record<string, unknown>) =>
        planFindings({
            record,
            transcript,
            config: meetingsConfigSchema.parse({}),
            findings: findingsFileSchema.parse([
                {
                    kind: "question",
                    from: 4,
                    to: 10,
                    question: "Is this the second voice?",
                    choices: ["Yes", "No"],
                    ...finding,
                },
            ]),
        }).findings[0];

    expect(plan({})).toMatchObject({ status: "applied", lines: [{ index: 1 }, { index: 2 }] });
    expect(plan({ heard: "Other voice" })).toMatchObject({ status: "applied", lines: [{ index: 1 }, { index: 2 }] });
    expect(plan({ about: "term", heard: "never said" })).toMatchObject({ status: "not-found", lines: [] });
});

test("CLI finding batches preserve retries and forward explicit duplicates through the service action schema", async () => {
    const { Command } = await import("commander");
    const { ui } = await import("@genesiscz/utils/cli/ui");
    const { registerItemCommands } = await import("../commands/items");
    const clients = await import("./service/client");
    const store = new MeetingStore();
    const record = await store.create(
        { title: "Batch insertion fixture", start: "2026-11-02T10:00:00Z", createdBy: "new" },
        { command: "fixture", change: "created" }
    );
    const batch = join(store.root, "replay-findings.json");
    writeFileSync(batch, SafeJSON.stringify(findings));
    const client = new clients.InProcessMeetingsClient({ deps: { store: () => store, ledger: () => {} } });
    const connect = spyOn(clients, "withMeetingsClient").mockImplementation(async (work) => work(client));
    const warning = spyOn(ui, "warn").mockImplementation(() => {});
    const info = spyOn(ui, "info").mockImplementation(() => {});
    const ok = spyOn(ui, "ok").mockImplementation(() => {});
    const invoke = async (extra: string[] = []) => {
        const program = new Command().exitOverride();
        registerItemCommands(program);
        await program.parseAsync(["items", "add", record.id, "--from-file", batch, ...extra], { from: "user" });
    };
    try {
        await invoke();
        const first = new MeetingStore().read(record.id)!;
        expect(first.items).toHaveLength(2);
        const bytes = readFileSync(store.path(record.id));
        const mtime = statSync(store.path(record.id)).mtimeMs;
        const journalFile = join(store.folder(record.id), "decisions.ndjson");
        const journal = readFileSync(journalFile);
        await invoke();
        expect(new MeetingStore().read(record.id)).toEqual(first);
        expect(readFileSync(store.path(record.id))).toEqual(bytes);
        expect(statSync(store.path(record.id)).mtimeMs).toBe(mtime);
        expect(readFileSync(journalFile)).toEqual(journal);
        for (const item of first.items) {
            expect(warning.mock.calls.some(([text]) => String(text).includes(item.id))).toBe(true);
        }
        await invoke(["--allow-duplicates"]);
        const explicit = new MeetingStore().read(record.id)!;
        expect(explicit.items).toHaveLength(4);
        expect(new DecisionJournal({ store: new MeetingStore(), ledger: () => {} }).read(record.id)).toHaveLength(2);
        expect(explicit.items.filter((item) => item.kind === "question").at(-1)).toMatchObject({ decides: ["i4"] });
    } finally {
        client.close();
        connect.mockRestore();
        warning.mockRestore();
        info.mockRestore();
        ok.mockRestore();
    }
});

test("automatic question reach counts only the targets of one answer", async () => {
    const { questionFor } = await import("./questions");
    const { selectQuestions } = await import("./question-select");
    const { meetingItemSchema } = await import("@genesiscz/utils/meetings/record");
    const range = meetingItemSchema.parse({
        id: "i1",
        kind: "speaker-range",
        status: "suggested",
        label: "Room",
        fromSec: 0,
        toSec: 10,
        speaker: "Alice",
        confidence: 0.4,
        rules: [],
        suggestedAt: "2026-11-01T10:00:00Z",
    });
    const question = questionFor(range, {
        listenBelow: 0.6,
        transcript: [
            {
                startSec: 0,
                speaker: "Room",
                text: "We will prepare the export and send the completed document to our colleagues before the next meeting.",
            },
        ],
        points: [],
        presence: [
            { name: "Alice", fromSec: 0, toSec: 30 },
            { name: "Bob", fromSec: 0, toSec: 30 },
        ],
    })!;
    expect(question.choices).toEqual(["Alice", "Bob"]);
    const selected = selectQuestions(
        Array.from({ length: 40 }, (_, n) => ({
            ...question,
            fromSec: n * 20,
            toSec: n * 20 + 10,
            decides: [`i${n + 1}`],
            clip: undefined,
        })),
        []
    );
    expect(selected.every((one) => one.priority! >= 1 && one.priority! <= 3)).toBe(true);
    expect(selected.every((one) => one.evidence?.reach === 1)).toBe(true);
});

test("a dead line term refuses insertion unless forced and names the actual heard line", () => {
    const term = findingsFileSchema.parse([
        {
            kind: "term",
            at: 0,
            heard: "Other",
            proposed: "Another",
            scope: "line",
            confidence: 0.8,
            reason: "spelling",
        },
    ]);
    expect(() => prepareFindings({ findings: term, items: [], transcript })).toThrow("heard at 00:05 (line 1)");
});

test("term diagnostics distinguish absent time, wrong line and unheard word and force roundtrips", async () => {
    const { diagnoseTermAddress } = await import("./term-address");
    const store = new MeetingStore(new Storage("cms-forced-anchor"));
    const record = await store.create(
        { title: "Anchor fixture", start: "2026-11-01T10:00:00Z", createdBy: "new" },
        { command: "fixture", change: "create" }
    );
    const journal = new DecisionJournal({
        store,
        listenBelow: 0.6,
        ledger: () => {},
        split: { transcript: async () => transcript },
    });
    const finding = findingsFileSchema.parse([
        {
            kind: "term",
            at: 0,
            heard: "Other",
            proposed: "Another",
            scope: "line",
            confidence: 0.8,
            reason: "spelling",
        },
    ]);
    await expect(
        journal.apply({ meeting: record.id, action: { kind: "add", findings: finding }, actor: { kind: "listen" } })
    ).rejects.toThrow("heard at 00:05");
    await journal.apply({
        meeting: record.id,
        action: { kind: "add", findings: finding, force: true },
        actor: { kind: "listen" },
    });
    const saved = new MeetingStore(store.storage).read(record.id)!.items[0]!;
    if (saved.kind !== "term") {
        throw new Error("expected term");
    }
    expect(diagnoseTermAddress({ item: saved, transcript })?.kind).toBe("wrong-line");
    expect(diagnoseTermAddress({ item: { ...saved, atSec: 40 }, transcript })?.kind).toBe("no-line");
    expect(diagnoseTermAddress({ item: { ...saved, heard: "Missing" }, transcript })?.kind).toBe("not-heard");
    expect(diagnoseTermAddress({ item: { ...saved, atSec: 5 }, transcript })?.kind).toBe("found");
});

test("dictionary draft preview changes only matching whole tokens and never the config", async () => {
    const { testPhrase } = await import("./dictionary-test");
    const config = meetingsConfigSchema.parse({});
    const before = SafeJSON.stringify(config);
    const preview = testPhrase(config, {
        phrase: "Loma and Loma-la\nLoma",
        entry: { type: "fix", value: "Loma", substitution: "Luma" },
    });
    expect(preview.text).toBe("Luma and Loma-la\nLuma");
    expect(preview.fired).toHaveLength(1);
    expect(SafeJSON.stringify(config)).toBe(before);
});

describe("an agent's reason is written for the person who reads it (U18)", () => {
    const PLAIN_WORDS = "Write the reason in plain words for the person who reads it";
    const label = { kind: "label", from: 0, to: 6103, label: "Bob Example", meaningless: true };

    test("a field name, a rule id or a labeler code in a reason is refused with a plain-words hint", async () => {
        const { findingSchema } = await import("./findings");

        for (const reason of [
            "Štítek nesleduje jednoho člověka; indikátor chybí (meeting.indicatorGaps).",
            "Podle evidence.reason je to jiný hlas.",
            "Pravidlo RA tu neplatí.",
            "R18 a E1 se neshodují.",
            "Mikrofon je seat-of-one.",
        ]) {
            const parsed = findingSchema.safeParse({ ...label, reason });
            expect(parsed.success).toBe(false);
            expect(parsed.error?.issues.map((issue) => issue.message)).toContain(PLAIN_WORDS);
        }

        for (const reason of [
            "Štítek nesleduje jednoho člověka: pod ním mluví dva lidé.",
            "Generovaný balíček @org.example.restapi.",
            "Rozhraní Nabídek v admin-console.",
            "HoHo = Bob Example.",
            "Viz https://example.com/docs/page.html, řádek 4.",
        ]) {
            expect(findingSchema.safeParse({ ...label, reason }).success).toBe(true);
        }
    });
});

describe("findings from per-line decisions", () => {
    // Three labels; lines 11 and 12 are one label's two lines in one second; line 8 and line 21 have no decision.
    const lines: Array<[number, string]> = [
        [0, "Speaker 1"],
        [4, "Speaker 2"],
        [8, "Speaker 2"],
        [12, "Speaker 1"],
        [15, "Speaker 2"],
        [20, "Speaker 3"],
        [23, "Speaker 3"],
        [27, "Speaker 2"],
        [30, "Speaker 3"],
        [33, "Speaker 3"],
        [36, "Speaker 3"],
        [40, "Speaker 2"],
        [40, "Speaker 2"],
        [44, "Speaker 2"],
        [47, "Speaker 2"],
        [50, "Speaker 1"],
        [53, "Speaker 1"],
        [56, "Speaker 3"],
        [59, "Speaker 3"],
        [62, "Speaker 1"],
        [65, "Speaker 1"],
        [68, "Speaker 2"],
    ];
    const transcript = lines.map(([startSec, speaker], index) => ({ startSec, speaker, text: `Line number ${index}` }));
    const record = meetingRecordSchema.parse({
        id: "2026-11-25_10-00-decisions",
        title: "Decisions",
        start: "2026-11-25T10:00:00.000Z",
        createdAt: "2026-11-25T10:00:00.000Z",
        createdBy: "new",
        participants: ["Alice Example", "Bob Example", "Carol Example"].map((name) => ({ name, from: [] })),
        speakers: { labels: { "Speaker 1": "Alice Example" } },
    });
    const bob = "Bob's voice and he answers the question before";
    const carol = "Carol's voice, she presents the plan";
    const alice = "Alice runs the call";
    const decisions = decisionsFileSchema.parse([
        { idx: 0, speaker: "Alice Example", confidence: 0.9, reason: alice },
        { idx: 1, speaker: "Bob Example", confidence: 0.9, reason: bob },
        { idx: 2, speaker: "Bob Example", confidence: 0.7, reason: bob },
        // An initial, as the legend prints it, of the label's own person.
        { idx: 3, speaker: "A", confidence: 0.95, reason: alice },
        { idx: 4, speaker: "Bob Example", confidence: 0.8, reason: bob },
        { idx: 5, speaker: "Carol Example", confidence: 0.6, reason: carol },
        { idx: 6, speaker: "Carol Example", confidence: 0.9, reason: carol },
        { idx: 7, speaker: "Carol Example", confidence: 0.8, reason: carol },
        // A full name in another case.
        { idx: 9, speaker: "carol example", confidence: 0.9, reason: carol },
        { idx: 10, speaker: "Carol Example", confidence: 0.9, reason: carol },
        { idx: 11, speaker: "Carol Example", confidence: 0.85, reason: carol },
        { idx: 12, speaker: "Bob Example", confidence: 0.9, reason: bob },
        { idx: 13, speaker: "B", confidence: 0.9, reason: bob },
        { idx: 14, speaker: "Bob Example", confidence: 0.6, reason: bob },
        { idx: 15, speaker: "?", confidence: 0.5, reason: "Two people talk over each other" },
        { idx: 16, speaker: "Alice Example", confidence: 0.9, reason: alice },
        { idx: 17, speaker: "Bob Example", confidence: 0.7, reason: "Bob names his own task" },
        { idx: 18, speaker: "Bob Example", confidence: 0.7, reason: "Bob answers Carol" },
        { idx: 19, speaker: "Bob Example", confidence: 0.8, reason: "Bob sits at Alice's microphone" },
        { idx: 20, speaker: "Bob Example", confidence: 0.9, reason: "Bob sits at Alice's microphone" },
    ]);
    const range = (from: number, to: number, label: string, speaker: string, confidence: number, reason: string) => ({
        kind: "speaker-range" as const,
        from,
        to,
        label,
        speaker,
        confidence,
        reason,
    });

    test("20 decisions over three labels give one finding per run of a label's lines, and the plan names the same lines", () => {
        expect(decisions).toHaveLength(20);
        const findings = findingsFromDecisions({ record, transcript }, decisions);
        expect(findings).toEqual([
            // Line 3 belongs to another label, so lines 1, 2 and 4 are one run of Speaker 2.
            range(4, 15, "Speaker 2", "Bob Example", 0.7, bob),
            range(20, 23, "Speaker 3", "Carol Example", 0.6, carol),
            range(27, 27, "Speaker 2", "Carol Example", 0.8, carol),
            // Line 8 has no decision, so it ends the run of lines 5 and 6.
            range(33, 36, "Speaker 3", "Carol Example", 0.9, carol),
            { ...range(40, 40, "Speaker 2", "Carol Example", 0.85, carol), line: 11 },
            { ...range(40, 40, "Speaker 2", "Bob Example", 0.9, bob), line: 12 },
            range(44, 47, "Speaker 2", "Bob Example", 0.6, bob),
            {
                kind: "label" as const,
                from: 50,
                to: 50,
                label: "Speaker 1",
                meaningless: true,
                confidence: 0.5,
                reason: "Two people talk over each other",
            },
            range(56, 56, "Speaker 3", "Bob Example", 0.7, "Bob names his own task"),
            range(59, 59, "Speaker 3", "Bob Example", 0.7, "Bob answers Carol"),
            range(62, 65, "Speaker 1", "Bob Example", 0.8, "Bob sits at Alice's microphone"),
        ]);
        // The findings are what `items add --from-file` takes, and its plan names exactly the decided lines.
        const plan = planFindings({
            findings: findingsFileSchema.parse(findings),
            record,
            transcript,
            config: meetingsConfigSchema.parse({}),
        });
        expect(plan.warnings).toEqual([]);
        expect(plan.findings.map((finding) => finding.lines.map((line) => line.index))).toEqual([
            [1, 2, 4],
            [5, 6],
            [7],
            [9, 10],
            [11],
            [12],
            [13, 14],
            [15],
            [17],
            [18],
            [19, 20],
        ]);
    });

    test("a decision the transcript cannot place stops the whole batch", () => {
        const placed = decisionsFileSchema.parse([
            { idx: 1, speaker: "Bob Example", confidence: 0.9, reason: bob },
            { idx: 1, speaker: "Carol Example", confidence: 0.9, reason: carol },
            { idx: 22, speaker: "Bob Example", confidence: 0.9, reason: bob },
            { idx: 2, speaker: "Zed Example", confidence: 0.9, reason: bob },
        ]);
        expect(() => findingsFromDecisions({ record, transcript }, placed)).toThrow(
            '#2 (line 1) is decided twice; #3 (line 22) is past the last transcript line, 21; #4 (line 2) names "Zed Example", whom the meeting does not know; known people: Alice Example (A), Bob Example (B), Carol Example (C); "?" names nobody in particular'
        );
        expect(
            decisionsFileSchema.safeParse([{ idx: 1, speaker: "Bob Example", confidence: 0.9, reason: "rule RA" }])
                .success
        ).toBe(false);
    });

    test("an initial is the first letter, or every word's first letter when two people share it", () => {
        expect([...personInitials(["Alice Example", "Adam Smith", "Bob Example"])]).toEqual([
            ["Bob Example", "B"],
            ["Alice Example", "AE"],
            ["Adam Smith", "AS"],
        ]);
    });
});

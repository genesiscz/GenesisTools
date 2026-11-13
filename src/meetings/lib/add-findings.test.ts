import { describe, expect, spyOn, test } from "bun:test";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { meetingsConfigSchema } from "@genesiscz/utils/meetings/config";
import { MeetingStore } from "@genesiscz/utils/meetings/record";
import { Storage } from "@genesiscz/utils/storage";
import { prepareFindings } from "./add-findings";
import { DecisionJournal } from "./decision-journal";
import { findingsFileSchema } from "./findings";

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

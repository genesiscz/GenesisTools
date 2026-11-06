import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { meetingsConfigSchema } from "@genesiscz/utils/meetings/config";
import { MeetingStore } from "@genesiscz/utils/meetings/record";
import type { MeetingEvidence, SourceMeeting, TranscriptSource } from "@genesiscz/utils/meetings/sources";
import { Storage } from "@genesiscz/utils/storage/storage";
import { loadPresence } from "./attendance";
import { CallTimeline } from "./call-timeline";
import { OpenedMeeting } from "./opened-meeting";

let stores = 0;

function fakeSource(options: { evidence?: MeetingEvidence | null; clock?: string | null } = {}): TranscriptSource {
    const meeting: SourceMeeting = {
        sourceMeetingId: "abc",
        title: "Planning",
        start: "2026-11-02T15:00:00.000Z",
        participants: [{ name: "Alice Example", self: true, from: ["fake"] }],
        speakers: [],
        transcript: [
            { speaker: "Alice Example", startSec: 0, text: "Ahoj." },
            { speaker: "Speaker 2", startSec: 10, text: "Čau." },
        ],
        folders: [],
    };

    return {
        id: "wisprflow",
        label: "Fake",
        load: async () => meeting,
        revision: async () => null,
        describe: () => ({ meetingId: "abc" }),
        dictionary: async () => [],
        recordingClock: async () =>
            options.clock === null ? null : { startedAt: options.clock ?? "2026-11-02T15:00:05.000Z" },
        evidence: async () =>
            options.evidence === undefined
                ? {
                      selfName: "Alice Example",
                      platform: "google_meet",
                      segments: [],
                      speaking: [{ tSec: 10, speaking: ["Carol Example"] }],
                      files: [],
                  }
                : options.evidence,
        liveRecording: async () => null,
        calendarEntries: async () => ({ ok: true, from: "wisprflow", entries: [] }),
        folders: async () => [],
        meetingFolders: async () => [],
        folderWrite: { supported: false, reason: "fake", manualStep: "none" },
    };
}

async function newRecord(fields: Record<string, unknown> = {}) {
    stores += 1;
    const store = new MeetingStore(new Storage(`meetings-opened-${process.pid}-${stores}`));
    const record = await store.create(
        {
            title: "Planning",
            start: "2026-11-02T15:00:00.000Z",
            createdBy: "new",
            participants: [{ name: "Alice Example", self: true, from: ["fake"] }],
            sources: { wisprflow: { meetingId: "abc" } },
            ...fields,
        },
        { command: "new", change: "test" }
    );
    return { store, record };
}

describe("OpenedMeeting", () => {
    test("inspecting uncached audio creates neither a cache nor record history", async () => {
        const { store, record } = await newRecord();
        const audioPath = join(store.folder(record.id), "audio.wav");
        writeFileSync(audioPath, "fixture");
        const opened = OpenedMeeting.of(store, record, {
            source: fakeSource({
                evidence: {
                    audioPath,
                    segments: [],
                    speaking: [],
                    files: [],
                },
            }),
            sourceMeetingId: "abc",
        });
        expect(await opened.energy()).toEqual({});
        expect(await opened.silentCallSpans()).toEqual([]);
        expect(existsSync(join(store.folder(record.id), "evidence"))).toBe(false);
        expect(store.read(record.id)?.history).toHaveLength(1);
    });

    test("reading the source, evidence, presence and energy never writes the record", async () => {
        const { store, record } = await newRecord({
            attendance: {
                from: "teams",
                people: [{ name: "alice@example.com", self: true, fromSec: 0, toSec: 60 }],
            },
        });
        const opened = OpenedMeeting.of(store, record, { source: fakeSource(), sourceMeetingId: "abc" });

        expect((await opened.meeting()).transcript).toHaveLength(2);
        expect((await opened.evidence())?.speaking).toHaveLength(1);
        expect(await opened.presence()).toEqual([{ name: "Alice Example", self: true, fromSec: 0, toSec: 60 }]);
        expect(await opened.energy()).toEqual({});
        expect(await opened.silentCallSpans()).toEqual([]);
        expect(await opened.calibrate()).toBeUndefined();
        expect(store.read(record.id)?.history).toHaveLength(1);
    });

    test("the evidence drops the speaking readings on a platform without a speaking indicator", async () => {
        const { store, record } = await newRecord({ platform: "facetime" });
        const opened = OpenedMeeting.of(store, record, { source: fakeSource(), sourceMeetingId: "abc" });

        expect((await opened.evidence())?.speaking).toEqual([]);
        expect((await opened.sourceEvidence())?.speaking).toHaveLength(1);
    });

    test("collect is an explicit step: it stores the platform the source names", async () => {
        const { store, record } = await newRecord();
        const opened = OpenedMeeting.of(store, record, { source: fakeSource(), sourceMeetingId: "abc" });
        const outcome = await opened.collect();

        expect(outcome.notes).toEqual([{ ok: true, text: "platform: Google Meet" }]);
        expect(opened.record.platform).toBe("google-meet");
        expect(store.read(record.id)?.platform).toBe("google-meet");
    });
});

describe("CallTimeline", () => {
    test("an open stay reaches the meeting end instead of the last departure", async () => {
        const { store, record } = await newRecord({ end: "2026-11-02T16:00:00.000Z" });
        const saved = await CallTimeline.stored(record).store(
            store,
            {
                note: "fixture",
                presence: [
                    { name: "Voice A", fromSec: 0, toSec: Infinity },
                    { name: "Voice B", fromSec: 0, toSec: 1200 },
                ],
            },
            "teams"
        );
        expect(saved.attendance?.people.map((stay) => stay.toSec)).toEqual([3600, 1200]);
    });

    test("second 0 is the source's clock, else what the recorder stored, else the record's start", async () => {
        const { record } = await newRecord({
            recording: { clock: { source: "wisprflow", startedAt: "2026-11-02T15:00:02.000Z" } },
        });
        const fromSource = await CallTimeline.ofSource(record, { source: fakeSource(), sourceMeetingId: "abc" });

        expect(fromSource.clock).toEqual({
            startedAt: "2026-11-02T15:00:05.000Z",
            from: "source",
            source: "wisprflow",
        });
        expect(fromSource.secAt(Date.parse("2026-11-02T15:01:05.000Z"))).toBe(60);
        expect(CallTimeline.stored(record).clock.from).toBe("recording");

        const { record: bare } = await newRecord();
        expect(CallTimeline.stored(bare).clock).toEqual({ startedAt: bare.start, from: "record" });
        const timeless = await CallTimeline.ofSource(bare, {
            source: fakeSource({ clock: null }),
            sourceMeetingId: "abc",
        });
        expect(timeless.clock.from).toBe("record");
    });

    test("stores stays once, with the user under their own name and sections derived", async () => {
        const { store, record } = await newRecord({ end: "2026-11-02T15:01:30.000Z" });
        const timeline = CallTimeline.stored(record);
        const stored = await timeline.store(
            store,
            {
                presence: [
                    { name: "alice@example.com", self: true, fromSec: 0, toSec: Number.POSITIVE_INFINITY },
                    { name: "Petr Novák", fromSec: 30, toSec: 90 },
                ],
                note: "test",
            },
            "teams"
        );

        expect(stored.attendance?.people.map((stay) => [stay.name, stay.toSec])).toEqual([
            ["Alice Example", 90],
            ["Petr Novák", 90],
        ]);
        expect(stored.sections?.map((section) => section.present)).toEqual([
            ["Alice Example"],
            ["Alice Example", "Petr Novák"],
        ]);
    });
});

describe("attendance from a file", () => {
    const dir = mkdtempSync(join(tmpdir(), "attendance-file-"));
    const teams = join(dir, "teams.json");
    writeFileSync(
        teams,
        SafeJSON.stringify([
            {
                meeting: { title: "Planning", startedAt: "2026-11-02T15:00:00.000Z" },
                attendance: [
                    { name: "Petr Novák", joinedAt: "2026-11-02T15:00:30.000Z", leftAt: "2026-11-02T15:10:00.000Z" },
                ],
            },
        ])
    );
    const other = join(dir, "other.json");
    writeFileSync(other, SafeJSON.stringify({ people: [] }));
    const target = { title: "Planning", start: "2026-11-02T15:00:00.000Z" };

    test("a bare path is read by the platform whose format it fits, a prefix names the platform", async () => {
        const bare = await loadPresence(target, teams);
        const prefixed = await loadPresence(target, `teams:${teams}`);

        expect(bare.presence).toEqual([{ name: "Petr Novák", fromSec: 30, toSec: 600 }]);
        expect(prefixed.presence).toEqual(bare.presence);
    });

    test("a file in no known format, or a platform without a file format, is refused with the formats it knows", async () => {
        await expect(loadPresence(target, other)).rejects.toThrow("no known attendance format (teams:");
        await expect(loadPresence(target, `facetime:${teams}`)).rejects.toThrow("FaceTime has no attendance file");
    });
});

describe("the word check provider per language", () => {
    test("Slovak remains available when Czech is off or unavailable", async () => {
        const { WORD_LANGUAGES } = await import("./word-languages");
        const { wordCheckFor } = await import("./word-check");
        const cs = spyOn(WORD_LANGUAGES.cs!, "open").mockResolvedValue({ available: false, reason: "missing" });
        const dispose = () => {};
        const sk = spyOn(WORD_LANGUAGES.sk!, "open").mockResolvedValue({
            available: true,
            check: {
                provider: "fixture",
                language: "sk",
                verdict: () => ({ class: "unknown", count: 0 }),
                dispose,
            },
        });
        try {
            for (const czech of ["off", "hunspell"] as const) {
                const opened = await wordCheckFor({ perLanguage: (code) => (code === "cs" ? czech : "hunspell") }, [
                    { speaker: "A", startSec: 0, text: "ľahký môžem ďalej" },
                    { speaker: "B", startSec: 10, text: "ještě dobře děkuju" },
                ]);
                expect(opened.check?.verdict("ľahký").class).toBe("unknown");
                expect(opened.check?.verdict("ještě").class).toBe("spoken");
                opened.check?.dispose();
            }
            expect(sk).toHaveBeenCalledTimes(2);
        } finally {
            cs.mockRestore();
            sk.mockRestore();
        }
    });

    test("each language uses its languages.<code>.wordCheck, and an unknown or missing one the default", async () => {
        const { configuredWordCheck, DEFAULT_WORD_CHECK, wordCheckFor } = await import("./word-check");
        const config = meetingsConfigSchema.parse({
            languages: { cs: { wordCheck: "off" }, sk: { wordCheck: "nonsense" } },
        });

        expect(configuredWordCheck(config, "cs")).toBe("off");
        expect(configuredWordCheck(config, "sk")).toBe(DEFAULT_WORD_CHECK);
        expect(configuredWordCheck(config, "de")).toBe(DEFAULT_WORD_CHECK);
        expect(
            (await wordCheckFor({ perLanguage: () => "off" }, [{ speaker: "A", startSec: 0, text: "Ahoj." }])).reason
        ).toBe("turned off for cs (languages.cs.wordCheck)");
    });
});

test("CLI suggestions use the shared runner and render its warnings", async () => {
    const { Command } = await import("commander");
    const runner = await import("./suggest-run");
    const { ui } = await import("@genesiscz/utils/cli/ui");
    const { out } = await import("@genesiscz/utils/logger");
    const { registerItemCommands } = await import("../commands/items");
    const { record } = await newRecord();
    const resolve = spyOn(MeetingStore.prototype, "resolve").mockReturnValue(record);
    const run = spyOn(runner, "runSuggest").mockResolvedValue({ fresh: [], warnings: ["context fixture warning"] });
    const warn = spyOn(ui, "warn").mockImplementation(() => {});
    const result = spyOn(out, "result").mockImplementation(() => {});
    try {
        const program = new Command();
        registerItemCommands(program);
        await program.parseAsync(["suggest", record.id, "--rules", "terms", "--word-check", "off", "--json"], {
            from: "user",
        });
        expect(run).toHaveBeenCalledTimes(1);
        expect(run.mock.calls[0][0]).toMatchObject({ record, rules: ["terms"], wordCheck: "off" });
        expect(warn).toHaveBeenCalledWith("context fixture warning");
        expect(result).toHaveBeenCalled();
    } finally {
        resolve.mockRestore();
        run.mockRestore();
        warn.mockRestore();
        result.mockRestore();
    }
});

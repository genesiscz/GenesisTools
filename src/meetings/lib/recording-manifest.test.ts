import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { type MeetingRecord, MeetingStore } from "@genesiscz/utils/meetings/record";
import { writePidFile } from "@genesiscz/utils/process/pidfile";
import { readFrameFolder } from "@genesiscz/utils/recording-editor/source";
import type { RecorderSettings } from "@genesiscz/utils/screen-recorder/control";
import type { OcrRow } from "@genesiscz/utils/screen-recorder/frame-output";
import { readRecordingManifest } from "@genesiscz/utils/screen-recorder/library";
import { Storage } from "@genesiscz/utils/storage/storage";
import { parseRereadSince } from "../commands/ocr";
import { appendFrameIndex, ocrBacklog, ocrPendingNote, readFrameIndex } from "./frame-index";
import {
    ensureOcrWorkers,
    FIRST_FRAME_HINT,
    LiveOcrSettings,
    OCR_FAILURES_BEFORE_RESTART,
    OCR_MAX_ATTEMPTS,
    OCR_OUTAGE_BACKOFF_MS,
    OCR_PID_FILE,
    OCR_SETTINGS_FILE,
    runOcrWorker,
} from "./ocr-worker";
import { meetingMovieZeroMs, writeMeetingRecordingManifest } from "./recording-manifest";
import { recordingSummary } from "./screen";
import { meetingScreen, readScreenRows } from "./screen-boxes";

const folder = mkdtempSync(join(tmpdir(), "gt-test-meeting-manifest-"));
afterAll(() => rmSync(folder, { recursive: true, force: true }));

const record = {
    id: "2026-03-02_10-00-meeting",
    title: "Weekly sync",
    recording: {
        startedAt: "2026-03-02T09:00:00.000Z",
        stoppedAt: "2026-03-02T09:30:00.000Z",
        displays: [{ id: 2, name: "Side", frames: 2 }],
    },
} as unknown as MeetingRecord;

describe("a meeting's screen recording as a recorder recording", () => {
    it("gives nothing for a meeting without frames", () => {
        expect(writeMeetingRecordingManifest(folder, record)).toBeUndefined();
    });

    it("lists every frame at its time from ocr.jsonl, in order, for the editor's frame reader", () => {
        mkdirSync(join(folder, "frames"));
        writeFileSync(join(folder, "frames", "10-00-05-000-d2.jpg"), "x");
        writeFileSync(join(folder, "frames", "10-00-01-500-d2.jpg"), "x");
        writeFileSync(
            join(folder, "ocr.jsonl"),
            [
                {
                    file: "frames/10-00-05-000-d2.jpg",
                    at: "2026-03-02T09:00:05.000Z",
                    displayId: 2,
                    changePercent: 12.5,
                    reason: "change",
                    text: "b",
                },
                { file: "frames/10-00-01-500-d2.jpg", at: "2026-03-02T09:00:01.500Z", displayId: 2, text: "a" },
            ]
                .map((row) => SafeJSON.stringify(row))
                .join("\n")
        );

        writeMeetingRecordingManifest(folder, record);
        const manifest = readRecordingManifest(folder);

        expect(manifest?.title).toBe("Weekly sync");
        expect(manifest?.frames.map((frame) => [frame.file, frame.atMs, frame.displayId])).toEqual([
            ["frames/10-00-01-500-d2.jpg", 1500, 2],
            ["frames/10-00-05-000-d2.jpg", 5000, 2],
        ]);
        expect(readFrameFolder(folder).map((frame) => frame.atUs)).toEqual([1_500_000, 5_000_000]);
        // A row the recorder wrote with its change percent keeps it; an older row without one reads 0.
        expect(manifest?.frames.map((frame) => [frame.changePercent, frame.reason])).toEqual([
            [0, "change"],
            [12.5, "change"],
        ]);
    });

    it("puts the record's markers into settings.markers on the frames' axis, also when an earlier run's frame is time 0", () => {
        const markers = [
            { at: "2026-03-02T09:00:03.250Z", label: "intro" },
            { at: "2026-03-02T09:10:00.000Z", label: "second start" },
        ];
        const marked = { ...record, recording: { ...record.recording, markers } } as MeetingRecord;
        // A later start: the movie still begins at the first frame of the first run.
        const restarted = {
            ...marked,
            recording: { ...marked.recording, startedAt: "2026-03-02T09:09:00.000Z" },
        } as MeetingRecord;

        expect(writeMeetingRecordingManifest(folder, marked)?.settings.markers).toEqual([
            { atMs: 3250, label: "intro" },
            { atMs: 600_000, label: "second start" },
        ]);
        expect(meetingMovieZeroMs(folder, "2026-03-02T09:00:00.000Z")).toBe(Date.parse("2026-03-02T09:00:00.000Z"));
        expect(writeMeetingRecordingManifest(folder, restarted)?.settings.markers).toEqual([
            { atMs: 1750, label: "intro" },
            { atMs: 598_500, label: "second start" },
        ]);
        expect(meetingMovieZeroMs(folder, "2026-03-02T09:09:00.000Z")).toBe(Date.parse("2026-03-02T09:00:01.500Z"));
        expect(writeMeetingRecordingManifest(folder, record)?.settings).toEqual({
            source: "meeting",
            meetingId: record.id,
        });
    });
});

describe("a meeting's ocr.jsonl after an interrupted run", () => {
    it("skips a cut-off row and a non-object row, and dates that frame by its file", () => {
        const cut = mkdtempSync(join(tmpdir(), "gt-test-meeting-manifest-cut-"));

        try {
            mkdirSync(join(cut, "frames"));
            writeFileSync(join(cut, "frames", "10-00-01-500-d2.jpg"), "x");
            writeFileSync(join(cut, "frames", "10-00-05-000-d2.jpg"), "x");
            const fileAt = new Date("2026-03-02T09:00:07.000Z");
            utimesSync(join(cut, "frames", "10-00-05-000-d2.jpg"), fileAt, fileAt);
            writeFileSync(
                join(cut, "ocr.jsonl"),
                [
                    SafeJSON.stringify({
                        file: "frames/10-00-01-500-d2.jpg",
                        at: "2026-03-02T09:00:01.500Z",
                        displayId: 2,
                    }),
                    "null",
                    '{"file":"frames/10-00-05-000-d2.jpg","at":"2026-03-02T09:00:0',
                ].join("\n")
            );

            expect(meetingMovieZeroMs(cut, "2026-03-02T09:00:00.000Z")).toBe(Date.parse("2026-03-02T09:00:00.000Z"));
            writeMeetingRecordingManifest(cut, record);
            expect(readRecordingManifest(cut)?.frames.map((frame) => [frame.file, frame.atMs])).toEqual([
                ["frames/10-00-01-500-d2.jpg", 1500],
                ["frames/10-00-05-000-d2.jpg", 7000],
            ]);
        } finally {
            rmSync(cut, { recursive: true, force: true });
        }
    });
});

describe("the frame index and the OCR worker (two phases)", () => {
    const settings: RecorderSettings["ocr"] = {
        enabled: true,
        languages: ["en-US"],
        minChars: 0,
        threshold: 5,
        skipTextless: false,
        region: "frame",
        read: "frame",
        tilePx: 960,
    };
    let stores = 0;

    /** A meeting with `frames` kept on disk and listed in its index; `ocr` rows already written, if any. */
    async function meetingWith(
        frames: Array<{ name: string; at: string; changePercent?: number; reason?: string; focusedDisplayId?: number }>
    ) {
        stores += 1;
        const store = new MeetingStore(new Storage(`meetings-ocr-worker-${process.pid}-${stores}`));
        const created = await store.create(
            { title: "OCR fixture", start: "2026-11-11T14:00:00.000Z", createdBy: "record" },
            { command: "test", change: "fixture" }
        );
        const dir = store.folder(created.id);
        mkdirSync(join(dir, "frames"), { recursive: true });
        const add = (frame: (typeof frames)[number]) => {
            writeFileSync(join(dir, "frames", frame.name), "jpeg");
            appendFrameIndex(dir, {
                file: `frames/${frame.name}`,
                at: new Date(frame.at),
                displayId: 1,
                focusedDisplayId: frame.focusedDisplayId,
                changePercent: frame.changePercent ?? 40,
                reason: frame.reason ?? "change",
                motionBoxes: [],
            });
        };

        for (const frame of frames) {
            add(frame);
        }

        return { store, id: created.id, dir, add };
    }

    /** A recognizer that throws `failures(path, call)` times for a frame, then reads its name back as the text. */
    function fakeEngine(fails: (file: string, attempt: number) => boolean) {
        const attempts = new Map<string, number>();
        const engine = {
            reads: [] as string[],
            restarts: 0,
            recognize: async (image: string) => {
                const name = image.split("/").at(-1) ?? image;
                const attempt = (attempts.get(name) ?? 0) + 1;
                attempts.set(name, attempt);
                engine.reads.push(name);

                if (fails(name, attempt)) {
                    throw new Error("TextRecognition.CRImageReaderError error 1");
                }

                return { text: `text of ${name}`, blocks: [] };
            },
            restart: () => {
                engine.restarts += 1;
            },
        };
        return engine;
    }

    function rows(dir: string): OcrRow[] {
        return readFileSync(join(dir, "ocr.jsonl"), "utf8")
            .trim()
            .split("\n")
            .map((line) => SafeJSON.parse(line, { strict: true }));
    }

    it("derives the index of a meeting from before frames.jsonl from ocr.jsonl, and prefers the index line", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-test-frame-index-"));

        try {
            writeFileSync(
                join(dir, "ocr.jsonl"),
                `${[
                    { file: "frames/b-d2.jpg", at: "2026-03-02T09:00:05.000Z", text: "old" },
                    { file: "frames/a-d1.jpg", at: "2026-03-02T09:00:01.000Z", displayId: 1, changePercent: 3 },
                ]
                    .map((row) => SafeJSON.stringify(row))
                    .join("\n")}\n`
            );
            expect(readFrameIndex(dir).map((row) => [row.file, row.displayId, row.changePercent])).toEqual([
                ["frames/a-d1.jpg", 1, 3],
                ["frames/b-d2.jpg", 2, 0],
            ]);

            appendFrameIndex(dir, {
                file: "frames/c-d1.jpg",
                at: new Date("2026-03-02T09:00:03.000Z"),
                displayId: 1,
                changePercent: 9,
                reason: "change",
                motionBoxes: [[1, 2, 3, 4]],
            });
            expect(readFrameIndex(dir).map((row) => row.file)).toEqual([
                "frames/a-d1.jpg",
                "frames/c-d1.jpg",
                "frames/b-d2.jpg",
            ]);
            expect(ocrBacklog(dir).map((row) => row.file)).toEqual(["frames/c-d1.jpg"]);

            // A row cut after its file name (a crash, a full disk) is no OCR of that frame, and neither is the
            // cut row the next append ran onto.
            const ocr = join(dir, "ocr.jsonl");
            writeFileSync(ocr, `${readFileSync(ocr, "utf8")}{"file":"frames/c-d1.jpg","results":[{"te`);
            expect(ocrBacklog(dir).map((row) => row.file)).toEqual(["frames/c-d1.jpg"]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("dates a frame that has no OCR row yet by its index line in the manifest", async () => {
        const meeting = await meetingWith([{ name: "f1-d1.jpg", at: "2026-11-11T14:00:02.000Z" }]);
        const zero = Date.parse("2026-11-11T14:00:00.000Z");
        writeMeetingRecordingManifest(meeting.dir, {
            ...record,
            recording: { startedAt: "2026-11-11T14:00:00.000Z" },
        } as unknown as MeetingRecord);

        expect(existsSync(join(meeting.dir, "ocr.jsonl"))).toBe(false);
        expect(readRecordingManifest(meeting.dir)?.frames.map((frame) => [frame.file, frame.atMs])).toEqual([
            ["frames/f1-d1.jpg", Date.parse("2026-11-11T14:00:02.000Z") - zero],
        ]);
    });

    it("keeps display focus when OCR finishes and when the recorder manifest is reopened", async () => {
        const meeting = await meetingWith([{ name: "focused.jpg", at: "2026-11-11T14:00:01Z", focusedDisplayId: 2 }]);
        await runOcrWorker({ store: meeting.store, meetingId: meeting.id, settings, engine: fakeEngine(() => false) });
        expect(readScreenRows(meeting.dir).rows[0]?.focusedDisplayId).toBe(2);
        writeMeetingRecordingManifest(meeting.dir, meeting.store.read(meeting.id)!);
        expect(readRecordingManifest(meeting.dir)?.frames[0]?.focusedDisplayId).toBe(2);
    });

    it("retries a read that throws, starts a fresh helper, writes a failed row when the next frame reads, retries it once reads work, and --retry-failed reads it again in place", async () => {
        const meeting = await meetingWith([
            { name: "f1-d1.jpg", at: "2026-11-11T14:00:01.000Z" },
            { name: "f2-d1.jpg", at: "2026-11-11T14:00:02.000Z" },
            { name: "f3-d1.jpg", at: "2026-11-11T14:00:03.000Z" },
        ]);
        // f1 fails twice (no restart), f2 fails on the old and on the fresh helper.
        const stuck = fakeEngine((name, attempt) => (name === "f1-d1.jpg" && attempt <= 2) || name === "f2-d1.jpg");
        const first = await runOcrWorker({ store: meeting.store, meetingId: meeting.id, settings, engine: stuck });

        // f2's first round, then its automatic second round after f3 read: a frame that read is the control.
        expect(first).toMatchObject({ status: "done", read: 3, reread: 1, failed: 2, restarts: 2, outages: 0 });
        expect(stuck.reads.filter((name) => name === "f2-d1.jpg")).toHaveLength(4 * OCR_FAILURES_BEFORE_RESTART);
        expect(rows(meeting.dir).map((row) => [row.file, row.text, row.failed, row.attempts])).toEqual([
            ["frames/f1-d1.jpg", "text of f1-d1.jpg", undefined, undefined],
            ["frames/f2-d1.jpg", "", "TextRecognition.CRImageReaderError error 1", 2],
            ["frames/f3-d1.jpg", "text of f3-d1.jpg", undefined, undefined],
        ]);
        expect(existsSync(join(meeting.dir, OCR_PID_FILE))).toBe(false);

        const working = fakeEngine(() => false);
        const retried = await runOcrWorker({
            store: meeting.store,
            meetingId: meeting.id,
            settings,
            engine: working,
            retryFailed: true,
        });

        expect(retried).toMatchObject({ read: 0, reread: 1, failed: 0 });
        expect(working.reads).toEqual(["f2-d1.jpg"]);
        expect(rows(meeting.dir).map((row) => [row.file, row.text, row.failed])).toEqual([
            ["frames/f1-d1.jpg", "text of f1-d1.jpg", undefined],
            ["frames/f2-d1.jpg", "text of f2-d1.jpg", undefined],
            ["frames/f3-d1.jpg", "text of f3-d1.jpg", undefined],
        ]);
    });

    it("completed OCR outage waits release their abort listeners", async () => {
        const meeting = await meetingWith([
            { name: "f1-d1.jpg", at: "2026-11-11T14:00:01.000Z" },
            { name: "f2-d1.jpg", at: "2026-11-11T14:00:02.000Z" },
        ]);
        const controller = new AbortController();
        const add = spyOn(controller.signal, "addEventListener");
        const remove = spyOn(controller.signal, "removeEventListener");
        let down = true;
        let waits = 0;
        const engine = fakeEngine((name, attempt) => !(name === "f1-d1.jpg" && attempt === 1) && down);
        const realTimeout = globalThis.setTimeout;
        const fastTimeout = Object.assign((...timerArgs: Parameters<typeof setTimeout>) => {
            const [callback, delay, ...args] = timerArgs;
            if (OCR_OUTAGE_BACKOFF_MS.some((ms) => ms === delay)) {
                waits += 1;
                return realTimeout(() => {
                    down = waits < 2;
                    callback(...args);
                }, 0);
            }
            return realTimeout(callback, delay, ...args);
        }, realTimeout);
        const timers = spyOn(globalThis, "setTimeout").mockImplementation(fastTimeout);
        try {
            const result = await runOcrWorker({
                store: meeting.store,
                meetingId: meeting.id,
                settings,
                engine,
                follow: true,
                pollMs: 100,
                recording: () => false,
                signal: controller.signal,
                failureNotices: "off",
            });
            expect(result).toMatchObject({ read: 2, failed: 0, outages: 1 });
            expect(waits).toBe(2);
            const added = add.mock.calls.filter(([name]) => name === "abort").map(([, listener]) => listener);
            const removed = remove.mock.calls.filter(([name]) => name === "abort").map(([, listener]) => listener);
            expect(added.length).toBeGreaterThanOrEqual(2);
            expect(new Set(removed)).toEqual(new Set(added));
        } finally {
            timers.mockRestore();
            add.mockRestore();
            remove.mockRestore();
        }
    });

    it("waits out an OCR outage on the same frame, says so once and again on recovery, and writes no failed row", async () => {
        for (const failureNotices of ["failing-and-recovered", "failing", "off"] as const) {
            const meeting = await meetingWith([
                { name: "f1-d1.jpg", at: "2026-11-11T14:00:01.000Z" },
                { name: "f2-d1.jpg", at: "2026-11-11T14:00:02.000Z" },
                { name: "f3-d1.jpg", at: "2026-11-11T14:00:03.000Z" },
            ]);
            let down = true;
            // f1 reads once; then every read fails, also of f1 (the control), until the second wait ends.
            const engine = fakeEngine((name, attempt) => !(name === "f1-d1.jpg" && attempt === 1) && down);
            const sleeps: number[] = [];
            const notices: string[] = [];
            const result = await runOcrWorker({
                store: meeting.store,
                meetingId: meeting.id,
                settings,
                engine,
                follow: true,
                pollMs: 100,
                recording: () => false,
                failureNotices,
                notify: (note) => {
                    notices.push(note.message);
                },
                sleep: async (ms) => {
                    sleeps.push(ms);
                    down = sleeps.length < 2;
                },
            });

            expect(sleeps).toEqual([OCR_OUTAGE_BACKOFF_MS[0], OCR_OUTAGE_BACKOFF_MS[1]]);
            expect(result).toMatchObject({ read: 3, failed: 0, outages: 1 });
            expect(rows(meeting.dir).map((row) => [row.text, row.failed])).toEqual([
                ["text of f1-d1.jpg", undefined],
                ["text of f2-d1.jpg", undefined],
                ["text of f3-d1.jpg", undefined],
            ]);
            expect(notices).toEqual(
                {
                    "failing-and-recovered": [
                        "Text reading (OCR) fails on this Mac; frames are kept and are read when it works again.",
                        "Text reading works again.",
                    ],
                    failing: [
                        "Text reading (OCR) fails on this Mac; frames are kept and are read when it works again.",
                    ],
                    off: [],
                }[failureNotices]
            );
        }
    });

    it("gives a bad frame at most 3 rounds of reads, each after reads worked again, and a frame that reads on a later round gets its text", async () => {
        const meeting = await meetingWith([
            { name: "f1-d1.jpg", at: "2026-11-11T14:00:01.000Z" },
            { name: "f2-d1.jpg", at: "2026-11-11T14:00:02.000Z" },
            { name: "f3-d1.jpg", at: "2026-11-11T14:00:03.000Z" },
        ]);
        const round = 2 * OCR_FAILURES_BEFORE_RESTART;
        // f2 never reads; f3 fails as f2's probe and in its own first round, then reads.
        const engine = fakeEngine(
            (name, attempt) => name === "f2-d1.jpg" || (name === "f3-d1.jpg" && attempt <= round + 1)
        );
        const run = () =>
            runOcrWorker({
                store: meeting.store,
                meetingId: meeting.id,
                settings,
                engine,
                sleep: async () => {
                    throw new Error("no outage here: f1 reads as the control");
                },
            });
        const rowOf = (file: string) => rows(meeting.dir).find((row) => row.file === file);

        await run();
        expect(rowOf("frames/f2-d1.jpg")).toMatchObject({ failed: expect.any(String), attempts: 2 });
        expect(rowOf("frames/f3-d1.jpg")).toMatchObject({ text: "text of f3-d1.jpg" });
        expect(rowOf("frames/f3-d1.jpg")?.failed).toBeUndefined();

        meeting.add({ name: "f4-d1.jpg", at: "2026-11-11T14:00:04.000Z" });
        await run();
        expect(rowOf("frames/f2-d1.jpg")).toMatchObject({ attempts: OCR_MAX_ATTEMPTS });

        meeting.add({ name: "f5-d1.jpg", at: "2026-11-11T14:00:05.000Z" });
        const before = engine.reads.filter((name) => name === "f2-d1.jpg").length;
        await run();
        expect(engine.reads.filter((name) => name === "f2-d1.jpg")).toHaveLength(before);
        expect(rows(meeting.dir).map((row) => row.file)).toEqual([
            "frames/f1-d1.jpg",
            "frames/f2-d1.jpg",
            "frames/f3-d1.jpg",
            "frames/f4-d1.jpg",
            "frames/f5-d1.jpg",
        ]);
    });

    it("goes on where ocr.jsonl ends, with the last row as the display's previous read", async () => {
        const meeting = await meetingWith([{ name: "f1-d1.jpg", at: "2026-11-11T14:00:01.000Z" }]);
        await runOcrWorker({ store: meeting.store, meetingId: meeting.id, settings, engine: fakeEngine(() => false) });
        // Below the OCR threshold: the frame keeps the previous text, which only the written row can give.
        meeting.add({ name: "f2-d1.jpg", at: "2026-11-11T14:00:02.000Z", changePercent: 1 });
        meeting.add({ name: "f3-d1.jpg", at: "2026-11-11T14:00:03.000Z" });
        const engine = fakeEngine(() => false);
        const resumed = await runOcrWorker({ store: meeting.store, meetingId: meeting.id, settings, engine });

        expect(resumed.read).toBe(2);
        expect(engine.reads).toEqual(["f3-d1.jpg"]);
        expect(rows(meeting.dir).map((row) => [row.file, row.text, row.skipped])).toEqual([
            ["frames/f1-d1.jpg", "text of f1-d1.jpg", undefined],
            ["frames/f2-d1.jpg", "text of f1-d1.jpg", "below-threshold"],
            ["frames/f3-d1.jpg", "text of f3-d1.jpg", undefined],
        ]);
    });

    it("ends a row torn by a crash before it appends: the next row starts on a line of its own and reads", async () => {
        const meeting = await meetingWith([{ name: "f1-d1.jpg", at: "2026-11-11T14:00:01.000Z" }]);
        await runOcrWorker({ store: meeting.store, meetingId: meeting.id, settings, engine: fakeEngine(() => false) });
        const ocr = join(meeting.dir, "ocr.jsonl");
        // A crash in the middle of f2's append: its row has no end and no line end.
        writeFileSync(ocr, `${readFileSync(ocr, "utf8")}{"file":"frames/f2-d1.jpg","at":"2026-11-11T14:0`);
        meeting.add({ name: "f2-d1.jpg", at: "2026-11-11T14:00:02.000Z" });
        const resumed = await runOcrWorker({
            store: meeting.store,
            meetingId: meeting.id,
            settings,
            engine: fakeEngine(() => false),
        });

        expect(resumed.read).toBe(1);
        expect(readScreenRows(meeting.dir).rows.map((row) => [row.file, row.text])).toEqual([
            ["frames/f1-d1.jpg", "text of f1-d1.jpg"],
            ["frames/f2-d1.jpg", "text of f2-d1.jpg"],
        ]);
    });

    it("gives a lone frame that never reads, with no other frame to check Vision on, a failed row after its rounds", async () => {
        const meeting = await meetingWith([{ name: "f1-d1.jpg", at: "2026-11-11T14:00:01.000Z" }]);
        const sleeps: number[] = [];
        const result = await runOcrWorker({
            store: meeting.store,
            meetingId: meeting.id,
            settings,
            engine: fakeEngine(() => true),
            failureNotices: "off",
            sleep: async (ms) => {
                sleeps.push(ms);

                if (sleeps.length > 10) {
                    throw new Error("the worker waits on a lone unreadable frame without end");
                }
            },
        });

        expect(sleeps).toEqual(OCR_OUTAGE_BACKOFF_MS.slice(0, OCR_MAX_ATTEMPTS));
        expect(result).toMatchObject({ read: 1, failed: 1 });
        expect(rows(meeting.dir).map((row) => [row.file, row.failed !== undefined])).toEqual([
            ["frames/f1-d1.jpg", true],
        ]);
    });

    it("--reread-empty-since reads the empty rows from that time again and leaves the earlier ones", async () => {
        const meeting = await meetingWith([
            { name: "f1-d1.jpg", at: "2026-11-11T14:00:01.000Z" },
            { name: "f2-d1.jpg", at: "2026-11-11T14:00:02.000Z" },
            { name: "f3-d1.jpg", at: "2026-11-11T14:00:03.000Z" },
        ]);
        writeFileSync(
            join(meeting.dir, "ocr.jsonl"),
            `${["f1-d1.jpg", "f2-d1.jpg", "f3-d1.jpg"]
                .map((name, i) =>
                    SafeJSON.stringify({
                        file: `frames/${name}`,
                        at: `2026-11-11T14:00:0${i + 1}.000Z`,
                        displayId: 1,
                        changePercent: 40,
                        reason: "change",
                        text: "",
                        blocks: [],
                    })
                )
                .join("\n")}\n`
        );
        const engine = fakeEngine(() => false);
        const result = await runOcrWorker({
            store: meeting.store,
            meetingId: meeting.id,
            settings,
            engine,
            rereadEmptySince: new Date("2026-11-11T14:00:02.000Z"),
        });

        expect(result).toMatchObject({ read: 0, reread: 2 });
        expect(rows(meeting.dir).map((row) => row.text)).toEqual(["", "text of f2-d1.jpg", "text of f3-d1.jpg"]);
    });

    it("leaves a meeting a live worker holds alone", async () => {
        const meeting = await meetingWith([{ name: "f1-d1.jpg", at: "2026-11-11T14:00:01.000Z" }]);
        writePidFile(join(meeting.dir, OCR_PID_FILE));

        try {
            const engine = fakeEngine(() => false);
            const result = await runOcrWorker({ store: meeting.store, meetingId: meeting.id, settings, engine });

            expect(result).toMatchObject({ status: "busy", holder: process.pid, read: 0 });
            expect(engine.reads).toEqual([]);
        } finally {
            rmSync(join(meeting.dir, OCR_PID_FILE), { force: true });
        }
    });

    it("--follow reads frames as the recorder lists them and ends once the recorder stopped and the backlog is read", async () => {
        const meeting = await meetingWith([{ name: "f1-d1.jpg", at: "2026-11-11T14:00:01.000Z" }]);
        let checks = 0;
        const result = await runOcrWorker({
            store: meeting.store,
            meetingId: meeting.id,
            settings,
            engine: fakeEngine(() => false),
            follow: true,
            pollMs: 100,
            recording: () => {
                checks += 1;

                if (checks === 2) {
                    // The recorder keeps a last frame and stops before the worker looks again.
                    meeting.add({ name: "f2-d1.jpg", at: "2026-11-11T14:00:02.000Z" });
                    return false;
                }

                return checks < 2;
            },
        });

        expect(result.read).toBe(2);
        expect(rows(meeting.dir).map((row) => row.file)).toEqual(["frames/f1-d1.jpg", "frames/f2-d1.jpg"]);
    });

    it("a written row counts as done by its file, with numeric-string bounds or blocks that do not parse; no second row", async () => {
        const meeting = await meetingWith([
            { name: "f1-d1.jpg", at: "2026-11-11T14:00:01.000Z" },
            { name: "f2-d1.jpg", at: "2026-11-11T14:00:02.000Z" },
            { name: "f3-d1.jpg", at: "2026-11-11T14:00:03.000Z", changePercent: 1 },
        ]);
        // As the recorder and DarwinKit wrote them: bounds and confidence as numeric strings.
        const stringBounds = SafeJSON.stringify({
            file: "frames/f1-d1.jpg",
            at: "2026-11-11T14:00:01.000Z",
            displayId: 1,
            changePercent: 40,
            reason: "change",
            text: "old text",
            blocks: [
                {
                    text: "old text",
                    confidence: "0.5",
                    bounds: { height: "0.0097", x: "0.1099", y: "0.2", width: "0.3" },
                },
            ],
        });
        const oddBlocks = SafeJSON.stringify({
            file: "frames/f2-d1.jpg",
            at: "2026-11-11T14:00:02.000Z",
            displayId: 1,
            text: "",
            blocks: [{ text: "x", bounds: "nope" }],
        });
        writeFileSync(join(meeting.dir, "ocr.jsonl"), `${stringBounds}\n${oddBlocks}\n`);
        const engine = fakeEngine(() => false);
        const result = await runOcrWorker({ store: meeting.store, meetingId: meeting.id, settings, engine });
        const lines = readFileSync(join(meeting.dir, "ocr.jsonl"), "utf8").trim().split("\n");

        expect(result.read).toBe(1);
        expect(engine.reads).toEqual([]);
        expect(lines.slice(0, 2)).toEqual([stringBounds, oddBlocks]);
        // The string-bounds row is the display's previous read: the frame below the threshold keeps its text.
        expect(rows(meeting.dir)[2]).toMatchObject({
            file: "frames/f3-d1.jpg",
            text: "old text",
            skipped: "below-threshold",
        });

        const again = await runOcrWorker({ store: meeting.store, meetingId: meeting.id, settings, engine });
        expect(again.read).toBe(0);
        expect(readFileSync(join(meeting.dir, "ocr.jsonl"), "utf8").trim().split("\n")).toHaveLength(3);
    });

    it("reads the recording's live OCR settings before each frame, without a restart", async () => {
        const meeting = await meetingWith([
            { name: "f1-d1.jpg", at: "2026-11-11T14:00:01.000Z" },
            { name: "f2-d1.jpg", at: "2026-11-11T14:00:02.000Z" },
        ]);
        const live = new LiveOcrSettings(join(meeting.dir, OCR_SETTINGS_FILE));
        live.write(settings);
        const engine = fakeEngine(() => false);
        const recognize = engine.recognize;
        engine.recognize = async (image: string) => {
            const read = await recognize(image);
            // `record set --ocr-min-chars 100` while the first frame is read: the second frame keeps no text.
            live.write({ ...settings, minChars: 100 });
            return read;
        };
        await runOcrWorker({ store: meeting.store, meetingId: meeting.id, settings, engine });

        expect(rows(meeting.dir).map((row) => row.text)).toEqual(["text of f1-d1.jpg", ""]);
    });

    it("a first frame with almost no text says why in recording.ocrWarning, which show lists", async () => {
        const meeting = await meetingWith([{ name: "f1-d1.jpg", at: "2026-11-11T14:00:01.000Z" }]);
        const engine = fakeEngine(() => false);
        engine.recognize = async () => ({ text: "desktop", blocks: [] });
        await runOcrWorker({ store: meeting.store, meetingId: meeting.id, settings, engine });
        const saved = meeting.store.read(meeting.id);

        expect(saved?.recording?.ocrWarning).toBe(FIRST_FRAME_HINT);
        expect(recordingSummary(saved!)).toContain(`OCR warning: ${FIRST_FRAME_HINT}`);
    });

    it("screen readers list a frame without OCR yet as pending, and count it", async () => {
        const meeting = await meetingWith([
            { name: "f1-d1.jpg", at: "2026-11-11T14:00:01.000Z" },
            { name: "f2-d1.jpg", at: "2026-11-11T14:00:02.000Z" },
        ]);
        const before = readScreenRows(meeting.dir);

        expect(before.pending).toBe(2);
        expect(ocrPendingNote(before.pending)).toBe("OCR pending (2 frames waiting)");
        expect(ocrPendingNote(1)).toBe("OCR pending (1 frame waiting)");

        writeFileSync(
            join(meeting.dir, "ocr.jsonl"),
            `${SafeJSON.stringify({ file: "frames/f1-d1.jpg", at: "2026-11-11T14:00:01.000Z", displayId: 1, text: "Roadmap", blocks: [] })}\n`
        );
        const after = readScreenRows(meeting.dir);

        expect(after.pending).toBe(1);
        expect(after.rows.map((row) => [row.file, row.text, row.pending])).toEqual([
            ["frames/f1-d1.jpg", "Roadmap", undefined],
            ["frames/f2-d1.jpg", "", true],
        ]);

        const record = meeting.store.read(meeting.id)!;
        const screen = await meetingScreen({ store: meeting.store, record, match: "roadmap" });
        expect(screen.pending).toBe(1);
        expect(screen.frames.map((frame) => frame.file)).toEqual(["frames/f1-d1.jpg"]);
    });

    it("--reread-empty-since takes a local time of the meeting's day or a full date", () => {
        const start = "2026-11-11T14:00:00.000Z";
        const local = parseRereadSince("15:56", { start });

        expect([local?.getDate(), local?.getHours(), local?.getMinutes()]).toEqual([new Date(start).getDate(), 15, 56]);
        expect(parseRereadSince("2026-11-11T14:56:00.000Z", { start })?.toISOString()).toBe("2026-11-11T14:56:00.000Z");
        expect(parseRereadSince("soon", { start })).toBeUndefined();
        for (const raw of ["24:00", "25:10", "15:75", "15:56:99", "23:59:60"]) {
            expect(parseRereadSince(raw, { start })).toBeUndefined();
        }
        const lastSecond = parseRereadSince("23:59:59", { start });
        expect([lastSecond?.getHours(), lastSecond?.getMinutes(), lastSecond?.getSeconds()]).toEqual([23, 59, 59]);
    });

    it("a local OCR reread time before the meeting start refers to the next calendar day", () => {
        const start = new Date(2026, 10, 11, 23, 30);
        const expected = new Date(2026, 10, 12, 0, 20);
        expect(parseRereadSince("00:20", { start: start.toISOString() })?.getTime()).toBe(expected.getTime());
        expect(parseRereadSince("23:45", { start: start.toISOString() })?.getTime()).toBe(
            new Date(2026, 10, 11, 23, 45).getTime()
        );
        const absolute = new Date(2026, 10, 11, 0, 20).toISOString();
        expect(parseRereadSince(absolute, { start: start.toISOString() })?.toISOString()).toBe(absolute);
    });

    it("ensureOcrWorkers starts a worker only for a recent meeting with frames that have no OCR row", async () => {
        const waiting = await meetingWith([{ name: "f1-d1.jpg", at: "2026-11-11T14:00:01.000Z" }]);
        const read = await meetingWith([{ name: "f1-d1.jpg", at: "2026-11-11T14:00:01.000Z" }]);
        await runOcrWorker({ store: read.store, meetingId: read.id, settings, engine: fakeEngine(() => false) });
        const now = new Date("2026-11-11T15:00:00.000Z");
        const startedWaiting: string[] = [];
        const startedRead: string[] = [];

        await ensureOcrWorkers(waiting.store, { now, start: (id) => startedWaiting.push(id) });
        await ensureOcrWorkers(read.store, { now, start: (id) => startedRead.push(id) });
        await ensureOcrWorkers(waiting.store, {
            now: new Date("2026-11-20T15:00:00.000Z"),
            start: (id) => startedWaiting.push(`late ${id}`),
        });

        expect(startedWaiting).toEqual([waiting.id]);
        expect(startedRead).toEqual([]);
    });

    it("an ended meeting's failed rows start a worker at most every 10 minutes, and a run with no new frame retries them once reads work", async () => {
        const ended = await meetingWith([
            { name: "f1-d1.jpg", at: "2026-11-11T14:00:01.000Z" },
            { name: "f2-d1.jpg", at: "2026-11-11T14:00:02.000Z" },
        ]);
        // f2 is bad in the first run (f1 reads, so the outage check calls it bad), then reads on its retry.
        await runOcrWorker({
            store: ended.store,
            meetingId: ended.id,
            settings,
            engine: fakeEngine((file) => file === "f2-d1.jpg"),
            sleep: async () => {},
            notify: () => {},
        });
        const failedRows = () =>
            readFileSync(join(ended.store.folder(ended.id), "ocr.jsonl"), "utf8")
                .trim()
                .split("\n")
                .filter((line) => line.includes('"failed"')).length;
        const before = failedRows();
        const started: string[] = [];
        const at = (min: number) => new Date(Date.parse("2026-11-11T15:00:00.000Z") + min * 60_000);

        await ensureOcrWorkers(ended.store, { now: at(0), start: (id) => started.push(id) });
        await ensureOcrWorkers(ended.store, { now: at(5), start: (id) => started.push(id) });
        await ensureOcrWorkers(ended.store, { now: at(11), start: (id) => started.push(id) });

        expect(before).toBeGreaterThan(0);
        expect(started).toEqual([ended.id, ended.id]);

        const retry = fakeEngine(() => false);
        await runOcrWorker({
            store: ended.store,
            meetingId: ended.id,
            settings,
            engine: retry,
            sleep: async () => {},
            notify: () => {},
        });

        expect(failedRows()).toBe(0);
        expect(retry.reads).toContain("f2-d1.jpg");
    });
});

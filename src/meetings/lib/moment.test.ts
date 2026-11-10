import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { registerRequestedTrees } from "@genesiscz/utils/cli/lazy-registrars";
import { ui } from "@genesiscz/utils/cli/ui";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { meetingsConfigSchema } from "@genesiscz/utils/meetings/config";
import { type MeetingRecord, MeetingStore, meetingRecordSchema } from "@genesiscz/utils/meetings/record";
import type { MeetingEvidence, SourceMeeting, TranscriptSource } from "@genesiscz/utils/meetings/sources";
import { Storage } from "@genesiscz/utils/storage/storage";
import type { TranscriptEntry } from "@genesiscz/utils/transcribe/types";
import { Command } from "commander";
import { MEETINGS_REGISTRARS } from "../registrars";
import type { cutClip } from "./audio";
import { writeQuestionClips } from "./listen-clips";
import * as moments from "./moment";
import {
    clipMoment,
    clipPlan,
    cutMoment,
    type MomentTarget,
    momentClipPath,
    momentFrames,
    momentsInText,
    openMoment,
    planMoment,
    SPEAKER_PAD_SEC,
    speakerStretches,
} from "./moment";
import { OpenedMeeting } from "./opened-meeting";
import { askedSpotSec, heardClip, type QuestionItem } from "./questions";

const now = "2026-11-09T10:00:00.000Z";

/** Speech ends at 65 s: the last line starts at 60 and a last line lasts 5 s. */
const transcript: TranscriptEntry[] = [
    { speaker: "Speaker 1", startSec: 10, text: "Dobrý den, začneme." },
    { speaker: "Speaker 1", startSec: 20, text: "Dej to do Ada a pak taky do zadání, prosím." },
    { speaker: "Speaker 2", startSec: 30, text: "Jo, rozumím." },
    { speaker: "Speaker 2", startSec: 40, text: "A co dál?" },
    { speaker: "Speaker 1", startSec: 60, text: "Konec." },
];

function record(items: Array<Record<string, unknown>>): MeetingRecord {
    return meetingRecordSchema.parse({
        id: "2026-11-09_10-00-planning",
        title: "Planning",
        start: now,
        createdAt: now,
        createdBy: "record",
        items: items.map((item) => ({ status: "suggested", rules: [], suggestedAt: now, ...item })),
    });
}

const meeting = record([
    { id: "i1", kind: "question", about: "term", heard: "zadání", fromSec: 20, toSec: 24, question: "Is it zadání?" },
    { id: "i2", kind: "question", about: "speaker", fromSec: 30, toSec: 40, question: "Who speaks?" },
    { id: "i3", kind: "term", atSec: 20, heard: "Ada", proposed: "ADA" },
    { id: "i4", kind: "term", heard: "Bob" },
    { id: "i5", kind: "speaker-range", label: "Speaker 2", fromSec: 30, toSec: 40, evidence: { endSec: 60 } },
]);

function question(id: string): QuestionItem {
    const item = meeting.items.find((one) => one.id === id);

    if (item?.kind !== "question") {
        throw new Error(`${id} is no question`);
    }

    return item;
}

const listen = meetingsConfigSchema.parse({}).global.playback.listen;

function plan(target: MomentTarget, settings = listen) {
    return planMoment({ record: meeting, transcript, listen: settings, target });
}

function refusal(target: MomentTarget): string {
    try {
        plan(target);
        return "planned";
    } catch (err) {
        return err instanceof Error && "code" in err ? String(err.code) : String(err);
    }
}

describe("a Moment of an item", () => {
    test("a word question plays its own occurrence: the spot is in the clip and the tone sounds just before it", () => {
        const moment = plan({ kind: "item", id: "i1" });
        const spot = askedSpotSec(question("i1"), transcript);

        expect(moment).toMatchObject({
            label: "Q1",
            ...heardClip(question("i1"), transcript),
            spotSec: spot,
            padSec: 5,
            tone: { atSec: spot - listen.tone.leadSec, sound: { hz: 880, sec: 0.15, volume: 0.6 } },
        });
        expect(moment.fromSec).toBeLessThan(spot);
        expect(moment.toSec).toBeGreaterThan(spot);
        expect(moment.startSec).toBe(moment.fromSec - 5);
        expect(moment.endSec).toBe(moment.toSec + 5);
    });

    test("a speaker question plays only the voice: its pad is the tone's lead plus the speaker pad", () => {
        expect(plan({ kind: "item", id: "i2" })).toMatchObject({
            fromSec: 30,
            toSec: 40,
            spotSec: 30,
            padSec: listen.tone.leadSec + SPEAKER_PAD_SEC,
            tone: { atSec: 30 - listen.tone.leadSec },
        });
    });

    test("a question's number names it as its id does, and an unknown one is refused", () => {
        expect(plan({ kind: "item", id: "Q2" })).toEqual({
            ...plan({ kind: "item", id: "i2" }),
            target: { kind: "item", id: "Q2" },
        });
        expect(refusal({ kind: "item", id: "Q9" })).toBe("unknown-item");
    });

    test("a term item hears its words around their spot; a term without a time has no Moment", () => {
        const moment = plan({ kind: "item", id: "i3" });

        expect(moment.label).toBe("i3");
        expect(moment.spotSec).toBeGreaterThan(20);
        expect(moment.fromSec).toBeLessThan(moment.spotSec);
        expect(moment.toSec).toBeGreaterThan(moment.spotSec);
        expect(refusal({ kind: "item", id: "i4" })).toBe("no-time");
    });

    test("a speaker range hears its last line to the end, padded as a voice", () => {
        expect(plan({ kind: "item", id: "i5" })).toMatchObject({
            fromSec: 30,
            toSec: 60,
            spotSec: 30,
            padSec: listen.tone.leadSec + SPEAKER_PAD_SEC,
        });
    });
});

describe("a Moment of a time, a range, a selection or a stretch", () => {
    test("a time hears the rest of its line, and near the end it stops where the speech ends", () => {
        expect(plan({ kind: "time", atSec: 45 })).toMatchObject({
            label: "00:45",
            fromSec: 45,
            toSec: 60,
            spotSec: 45,
        });
        expect(plan({ kind: "time", atSec: 62 })).toMatchObject({ fromSec: 62, toSec: 65 });
        expect(plan({ kind: "time", atSec: 90 })).toMatchObject({ fromSec: 90, toSec: 90 });
        expect(refusal({ kind: "time", atSec: 96 })).toBe("past-the-end");
    });

    test("a range is heard as given, from its start; one that ends before it starts is refused", () => {
        expect(plan({ kind: "range", fromSec: 30, toSec: 35 })).toMatchObject({
            label: "00:30–00:35",
            fromSec: 30,
            toSec: 35,
            spotSec: 30,
            padSec: 5,
        });
        expect(refusal({ kind: "range", fromSec: 35, toSec: 30 })).toBe("bad-range");
    });

    test("a transcript selection is the range its words span, each line's time spread over its text (R43)", () => {
        const moment = plan({
            kind: "selection",
            from: { atSec: 20, line: 1, fraction: 0.5 },
            to: { atSec: 30, fraction: 0.5 },
        });

        expect(moment).toMatchObject({ fromSec: 25, toSec: 35, spotSec: 25 });
        expect(refusal({ kind: "selection", from: { atSec: 21 }, to: { atSec: 30 } })).toBe("unknown-line");
    });

    // A source transcript can hold an empty segment beside a spoken line, and the window's line index comes from the
    // corrected transcript, so a hint can name a line with no words.
    test("a selection whose line hint names a line with no words takes the spoken line at that time", () => {
        const withEmpty: TranscriptEntry[] = [
            { speaker: "Speaker 1", startSec: 10, text: " " },
            { speaker: "Speaker 1", startSec: 10.2, text: "Dej to do Ada." },
            { speaker: "Speaker 2", startSec: 20, text: "Jo." },
        ];
        const moment = planMoment({
            record: meeting,
            transcript: withEmpty,
            listen,
            target: { kind: "selection", from: { atSec: 10, line: 0 }, to: { atSec: 10.2, line: 1 } },
        });

        expect(moment).toMatchObject({ fromSec: 10.2, toSec: 20 });
    });

    test("a stretch is one speaker's turn: the lines in a row under one label (R20, R21)", () => {
        expect(speakerStretches(transcript).map((one) => [one.speaker, one.fromSec, one.toSec])).toEqual([
            ["Speaker 1", 10, 30],
            ["Speaker 2", 30, 60],
            ["Speaker 1", 60, 65],
        ]);
        expect(plan({ kind: "stretch", atSec: 45 })).toMatchObject({
            label: "Speaker 2 00:30–01:00",
            fromSec: 30,
            toSec: 60,
            padSec: listen.tone.leadSec + SPEAKER_PAD_SEC,
        });
        expect(plan({ kind: "stretch", atSec: 45, speaker: "Speaker 1" })).toMatchObject({ fromSec: 60, toSec: 65 });
        expect(refusal({ kind: "stretch", atSec: 61, speaker: "Speaker 2" })).toBe("no-speech");
    });
});

describe("the playback settings a Moment carries", () => {
    test("the tone is absent when turned off, and its sound comes from the config (R8)", () => {
        const off = meetingsConfigSchema.parse({ global: { playback: { listen: { tone: { enabled: false } } } } });
        const silent = plan({ kind: "item", id: "i1" }, off.global.playback.listen);

        expect(silent.tone).toBeUndefined();
        expect(clipPlan(silent)).toEqual({ fromSec: silent.fromSec, toSec: silent.toSec, padSec: 5 });

        const low = meetingsConfigSchema.parse({ global: { playback: { listen: { tone: { sound: { hz: 440 } } } } } });
        expect(plan({ kind: "item", id: "i1" }, low.global.playback.listen).tone?.sound).toEqual({
            hz: 440,
            sec: 0.15,
            volume: 0.6,
        });
    });

    test("the delay and the repeat a surface applies come with the Moment; no repeat when it is off", () => {
        expect(plan({ kind: "time", atSec: 45 })).toMatchObject({ delaySec: 2, repeatGapSec: 1 });
        const once = meetingsConfigSchema.parse({ global: { playback: { listen: { repeat: false } } } });
        expect(plan({ kind: "time", atSec: 45 }, once.global.playback.listen).repeatGapSec).toBeUndefined();
    });

    test("the saved pad widens an around span, never a voice", () => {
        const wide = meetingsConfigSchema.parse({ global: { playback: { listen: { padSec: 10 } } } });

        expect(plan({ kind: "range", fromSec: 30, toSec: 35 }, wide.global.playback.listen).padSec).toBe(10);
        expect(plan({ kind: "item", id: "i2" }, wide.global.playback.listen).padSec).toBe(
            listen.tone.leadSec + SPEAKER_PAD_SEC
        );
    });
});

describe("times named in a text (R17, R38)", () => {
    test("ranges and lone times, with their place in the text", () => {
        const text = 'Who speaks under "Speaker 2" from 05:09 to 05:31? This answers 1:02:10–1:02:40, said at 1:49:48.';
        const mentions = momentsInText(text);

        expect(mentions.map((one) => [one.text, one.target])).toEqual([
            ["05:09 to 05:31", { kind: "range", fromSec: 309, toSec: 331 }],
            ["1:02:10–1:02:40", { kind: "range", fromSec: 3730, toSec: 3760 }],
            ["1:49:48", { kind: "time", atSec: 6588 }],
        ]);
        expect(mentions.map((one) => text.slice(one.start, one.end))).toEqual(mentions.map((one) => one.text));
    });

    test("a Czech range joins too, and two times with words between them stay two times", () => {
        expect(momentsInText("mezi 5:09 a 5:31").map((one) => one.target)).toEqual([
            { kind: "range", fromSec: 309, toSec: 331 },
        ]);
        expect(momentsInText("at 05:09, then again at 05:31").map((one) => one.target.kind)).toEqual(["time", "time"]);
        expect(momentsInText("5:31 to 5:09").map((one) => one.target.kind)).toEqual(["time", "time"]);
        expect(momentsInText("version 1.2, ratio 3:2:1:4")).toEqual([]);
    });
});

describe("cutting a Moment", () => {
    test("the cut gets the Moment's numbers and its tone's sound; nothing plays", async () => {
        const cuts: Array<Parameters<typeof cutClip>[0]> = [];
        const moment = plan({ kind: "item", id: "i1" });
        await cutMoment(moment, {
            audioPath: "/clips/call.ogg",
            outPath: "/clips/out.wav",
            cut: async (options) => {
                cuts.push(options);
            },
        });

        expect(cuts).toEqual([
            {
                audioPath: "/clips/call.ogg",
                outPath: "/clips/out.wav",
                fromSec: moment.fromSec,
                toSec: moment.toSec,
                padSec: 5,
                toneAtSec: moment.tone!.atSec,
                toneSound: { hz: 880, sec: 0.15, volume: 0.6 },
            },
        ]);
    });

    test("the same Moment writes the same file in the meeting folder; another span or tone writes another", () => {
        const one = plan({ kind: "item", id: "i1" });
        const path = momentClipPath("/m/planning", one);

        expect(path).toStartWith("/m/planning/moments/Q1-");
        expect(path).toEndWith(".wav");
        expect(momentClipPath("/m/planning", plan({ kind: "item", id: "i1" }))).toBe(path);
        expect(momentClipPath("/m/planning", { ...one, endSec: one.endSec + 1 })).not.toBe(path);
        expect(momentClipPath("/m/planning", { ...one, tone: undefined })).not.toBe(path);
    });

    test("listen --clip-out --json keeps its keys in their order (the contract a script reads)", async () => {
        const written = await writeQuestionClips({
            record: meeting,
            questions: [question("i1"), question("i2")],
            transcript,
            listen,
            padSec: 5,
            audioPath: "/clips/call.ogg",
            dir: "/clips/out",
            cut: async () => {},
        });
        const silent = meetingsConfigSchema.parse({ global: { playback: { listen: { tone: { enabled: false } } } } });
        const [quiet] = await writeQuestionClips({
            record: meeting,
            questions: [question("i2")],
            transcript,
            listen: silent.global.playback.listen,
            padSec: 5,
            audioPath: "/clips/call.ogg",
            dir: "/clips/out",
            cut: async () => {},
        });

        expect(written.map((clip) => Object.keys(clip))).toEqual([
            ["question", "id", "clip", "fromSec", "toSec", "padSec", "toneAtSec"],
            ["question", "id", "clip", "fromSec", "toSec", "padSec", "toneAtSec"],
        ]);
        expect(written[1]).toEqual({
            question: "Q2",
            id: "i2",
            clip: "/clips/out/Q2.wav",
            fromSec: 30,
            toSec: 40,
            padSec: listen.tone.leadSec + SPEAKER_PAD_SEC,
            toneAtSec: 30 - listen.tone.leadSec,
        });
        expect(Object.keys(quiet!)).toEqual(["question", "id", "clip", "fromSec", "toSec", "padSec"]);
    });
});

describe("the screen at a Moment (R41)", () => {
    test("each display's frame on screen at the spot; none before the first frame or without a recording", async () => {
        const store = new MeetingStore(new Storage("meetings-moment-screen"));
        const at = (sec: number) => new Date(Date.parse(now) + sec * 1000).toISOString();
        const recorded = meetingRecordSchema.parse({
            ...meeting,
            recording: { status: "stopped", spans: [{ from: at(0), to: at(120) }] },
        });
        const folder = store.folder(recorded.id);
        mkdirSync(folder, { recursive: true });
        const rows = [
            { file: "frames/a.jpg", at: at(5), displayId: 1, text: "Agenda" },
            { file: "frames/b.jpg", at: at(8), displayId: 2, text: "Notes" },
            { file: "frames/c.jpg", at: at(40), displayId: 1, text: "Budget" },
        ];
        writeFileSync(join(folder, "ocr.jsonl"), rows.map((row) => SafeJSON.stringify(row)).join("\n"));

        expect(await momentFrames(store, recorded, 30)).toEqual([
            { file: "frames/a.jpg", path: join(folder, "frames/a.jpg"), at: at(5), meetingSec: 5, displayId: 1 },
            { file: "frames/b.jpg", path: join(folder, "frames/b.jpg"), at: at(8), meetingSec: 8, displayId: 2 },
        ]);
        expect((await momentFrames(store, recorded, 45)).map((frame) => frame.file)).toEqual([
            "frames/c.jpg",
            "frames/b.jpg",
        ]);
        expect(await momentFrames(store, recorded, 2)).toEqual([]);
        expect(await momentFrames(store, { ...recorded, id: "2026-11-09_11-00-other" }, 30)).toEqual([]);
    });
});

/** A source that answers this file's transcript and keeps the recording at `audioPath`. */
function fakeSource(audioPath: string): TranscriptSource {
    const sourceMeeting: SourceMeeting = {
        sourceMeetingId: "abc",
        title: "Planning",
        start: now,
        participants: [],
        speakers: [],
        transcript,
        folders: [],
    };
    const evidence: MeetingEvidence = { audioPath, segments: [], speaking: [], files: [] };
    return {
        id: "wisprflow",
        label: "Fake",
        load: async () => sourceMeeting,
        revision: async () => null,
        describe: () => ({ meetingId: "abc" }),
        dictionary: async () => [],
        recordingClock: async () => null,
        evidence: async () => evidence,
        liveRecording: async () => null,
        calendarEntries: async () => ({ ok: true, from: "wisprflow", entries: [] }),
        folders: async () => [],
        meetingFolders: async () => [],
        folderWrite: { supported: false, reason: "fake", manualStep: "none" },
    };
}

describe("a Moment of a saved meeting", () => {
    test("its source transcript and the saved settings make the Moment, and the clip goes to moments/ in its folder", async () => {
        const store = new MeetingStore(new Storage("meetings-moment-saved"));
        const saved = await store.create(
            {
                title: "Planning",
                start: now,
                createdBy: "new",
                sources: { wisprflow: { meetingId: "abc" } },
                items: meeting.items,
            },
            { command: "new", change: "test" }
        );
        const opened = OpenedMeeting.of(store, saved, {
            source: fakeSource("/clips/call.ogg"),
            sourceMeetingId: "abc",
        });
        const target: MomentTarget = { kind: "item", id: "Q1" };
        const cuts: Array<Parameters<typeof cutClip>[0]> = [];
        const cut = await clipMoment({
            store,
            record: saved,
            target,
            opened,
            cut: async (options) => {
                cuts.push(options);
                mkdirSync(dirname(options.outPath), { recursive: true });
                writeFileSync(options.outPath, "RIFF");
            },
        });
        const planned = planMoment({ record: saved, transcript, listen, target });

        expect(await openMoment({ store, record: saved, target, opened })).toEqual({ ...planned, meeting: saved.id });
        expect(cut).toEqual({ ...planned, meeting: saved.id, path: momentClipPath(store.folder(saved.id), planned) });
        expect(cut.path).toStartWith(join(store.folder(saved.id), "moments", "Q1-"));
        // The cut writes beside the clip, and the clip takes its place once it is whole.
        expect(cuts).toEqual([{ audioPath: "/clips/call.ogg", outPath: expect.any(String), ...clipPlan(planned) }]);
        expect(dirname(cuts[0]!.outPath)).toBe(dirname(cut.path));
        expect(cuts[0]!.outPath).not.toBe(cut.path);
        expect(readFileSync(cut.path, "utf8")).toBe("RIFF");
    });

    // The window plays the clip at its path while a second play, or an agent's `play --clip`, cuts the same Moment.
    test("a second cut of the same Moment never leaves a half-written clip where a player reads it", async () => {
        const store = new MeetingStore(new Storage("meetings-moment-recut"));
        const saved = await store.create(
            {
                title: "Planning",
                start: now,
                createdBy: "new",
                sources: { wisprflow: { meetingId: "abc" } },
                items: meeting.items,
            },
            { command: "new", change: "test" }
        );
        const opened = OpenedMeeting.of(store, saved, {
            source: fakeSource("/clips/call.ogg"),
            sourceMeetingId: "abc",
        });
        const target: MomentTarget = { kind: "item", id: "Q1" };
        let halfWritten = (): void => {};
        const half = new Promise<void>((resolve) => {
            halfWritten = resolve;
        });
        let release = (): void => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        // Writes the clip as ffmpeg does: the header first, the samples later.
        const writer =
            (samples: string, wait?: Promise<void>) =>
            async (options: { outPath: string }): Promise<void> => {
                mkdirSync(dirname(options.outPath), { recursive: true });
                writeFileSync(options.outPath, "RIFF");

                if (wait) {
                    halfWritten();
                    await wait;
                }

                appendFileSync(options.outPath, samples);
            };

        const first = await clipMoment({ store, record: saved, target, opened, cut: writer("-first") });
        expect(readFileSync(first.path, "utf8")).toBe("RIFF-first");

        const second = clipMoment({ store, record: saved, target, opened, cut: writer("-second", gate) });
        await half;
        // A player that opens the clip now gets the whole first clip, never a header alone.
        expect(readFileSync(first.path, "utf8")).toBe("RIFF-first");
        release();
        expect(readFileSync((await second).path, "utf8")).toBe("RIFF-second");

        // A cut that fails leaves the last whole clip and no partial file beside it.
        const failing = clipMoment({
            store,
            record: saved,
            target,
            opened,
            cut: async (options) => {
                writeFileSync(options.outPath, "RIFF");
                throw new Error("ffmpeg failed");
            },
        });
        await expect(failing).rejects.toThrow("ffmpeg failed");
        expect(readFileSync(first.path, "utf8")).toBe("RIFF-second");
        expect(readdirSync(dirname(first.path))).toEqual([basename(first.path)]);
    });
});

describe("tools meetings play: what the flags name", () => {
    afterEach(() => {
        process.exitCode = 0;
    });

    async function refusal(...args: string[]): Promise<string[]> {
        const errors: string[] = [];
        const err = spyOn(ui, "err").mockImplementation((line: string) => {
            errors.push(line);
        });

        try {
            const program = new Command().exitOverride();
            await registerRequestedTrees({ program, registrars: MEETINGS_REGISTRARS, requested: "play" });
            await program.parseAsync(["play", ...args], { from: "user" });
        } finally {
            err.mockRestore();
        }

        expect(process.exitCode).toBe(1);
        return errors;
    }

    test("one of --at, --item and --target names what to play, and --to needs --at", async () => {
        expect(await refusal("m1")).toEqual(["Name what to play: --at <time>, --item <id> or --target <json>."]);
        expect(await refusal("m1", "--at", "5", "--item", "Q1")).toEqual([
            "--at, --item and --target each name what to play; give one of them.",
        ]);
        expect(await refusal("m1", "--item", "Q1", "--to", "1:00")).toEqual(["--to ends the range that --at starts."]);
    });

    // An agent adds --no-start to stay side-effect free: with --clip beside it the command cut a WAV into moments/.
    test("--no-start plans the Moment and cuts nothing, even with --clip", async () => {
        // The command reads the default store, which the test preload keeps in a sandbox.
        const store = new MeetingStore();
        const saved = await store.create(
            { title: "Planning", start: now, createdBy: "new", items: meeting.items },
            { command: "new", change: "test" }
        );
        const target: MomentTarget = { kind: "range", fromSec: 10, toSec: 20 };
        const planned = { ...planMoment({ record: saved, transcript, listen, target }), meeting: saved.id };
        const open = spyOn(moments, "openMoment").mockResolvedValue(planned);
        const cut = spyOn(moments, "clipMoment");
        const printed: string[] = [];
        const errors: string[] = [];
        const result = spyOn(out, "result").mockImplementation((text: string) => {
            printed.push(text);
        });
        const err = spyOn(ui, "err").mockImplementation((line: string) => {
            errors.push(line);
        });

        let calls = { open: 0, cut: 0 };

        try {
            const program = new Command().exitOverride();
            await registerRequestedTrees({ program, registrars: MEETINGS_REGISTRARS, requested: "play" });
            await program.parseAsync(
                ["play", saved.id, "--target", SafeJSON.stringify(target), "--clip", "--no-start", "--json"],
                { from: "user" }
            );
            // Counted before the restore, which clears them.
            calls = { open: open.mock.calls.length, cut: cut.mock.calls.length };
        } finally {
            open.mockRestore();
            cut.mockRestore();
            result.mockRestore();
            err.mockRestore();
        }

        expect(errors).toEqual([]);
        expect(calls).toEqual({ open: 1, cut: 0 });
        expect(SafeJSON.parse(printed[0]!)).toEqual(planned);
        expect(readdirSync(store.folder(saved.id))).not.toContain("moments");
    });

    test("--target is checked against the Moment targets before any meeting is read", async () => {
        expect(await refusal("m1", "--target", "{nope")).toEqual(["--target is not JSON: {nope"]);
        const [line] = await refusal("m1", "--target", '{"kind":"range","fromSec":-1,"toSec":5}');
        expect(line).toStartWith("--target is not a Moment target (");
    });
});

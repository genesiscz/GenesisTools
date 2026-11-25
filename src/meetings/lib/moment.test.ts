import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
    appendFileSync,
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { wisprflowSource } from "@app/wisprflow/lib/meeting-source";
import { registerRequestedTrees } from "@genesiscz/utils/cli/lazy-registrars";
import { ui } from "@genesiscz/utils/cli/ui";
import { SafeJSON } from "@genesiscz/utils/json";
import { meetingsConfigSchema, TONE_MAX_SEC } from "@genesiscz/utils/meetings/config";
import {
    JOINED_RECORD_VERSION,
    type MeetingRecord,
    MeetingStore,
    meetingRecordSchema,
} from "@genesiscz/utils/meetings/record";
import type { MeetingEvidence, SourceMeeting, TranscriptSource } from "@genesiscz/utils/meetings/sources";
import { makeWordTimingArtifact, wordTimingFile } from "@genesiscz/utils/meetings/word-timing-cache";
import { Storage } from "@genesiscz/utils/storage/storage";
import type { TranscriptEntry } from "@genesiscz/utils/transcribe/types";
import { Command } from "commander";
import { MEETINGS_REGISTRARS } from "../registrars";
import { type cutClip, playClip } from "./audio";
import { joinMeetings, repairJoin } from "./join-recordings";
import { questionClip, refineSplitClip, writeQuestionClips } from "./listen-clips";
import {
    clipMoment,
    clipPlan,
    cutMoment,
    type MomentTarget,
    momentCacheDir,
    momentCachePath,
    momentClipPath,
    momentFrames,
    momentsInText,
    openMoment,
    planMoment,
    SPEAKER_PAD_SEC,
    speakerStretches,
    trimMomentCache,
} from "./moment";
import { OpenedMeeting } from "./opened-meeting";
import { askedSpotSec, heardClip, type QuestionItem } from "./questions";
import * as screenBoxes from "./screen-boxes";
import { preservedSourceAudio, preserveSourceAudio, recordSourceAudio } from "./source-audio";
import { discoverSourceAudio } from "./source-audio-discovery";
import { copyBackedSource, readSourceCopy, recordingCopyFolder } from "./source-copy";
import { localMeetingTranscript, recordingCopyHolder } from "./sources";
import { resolveToneSound } from "./tone-sound";
import { correctedTranscriptRead, timedTranscriptView } from "./window-reads";
import { meetingWordTimingCache } from "./word-timings";

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
            toSec: 60,
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

    test("a voice asked at one instant is heard to the end of its line, as a single time is", () => {
        // A stretch of 0 s played only its two pads: a 1.4 s clip for "who says this?".
        const instant = record([
            { id: "i1", kind: "question", about: "speaker", fromSec: 30, toSec: 30, question: "Who says this?" },
            { id: "i2", kind: "speaker-range", label: "Speaker 2", fromSec: 40, toSec: 40 },
            { id: "i3", kind: "question", about: "speaker", fromSec: 20, toSec: 20.4, question: "Who says this?" },
            { id: "i4", kind: "question", about: "speaker", fromSec: 30, toSec: 31, question: "Who says this?" },
        ]);
        const at = (id: string) => planMoment({ record: instant, transcript, listen, target: { kind: "item", id } });

        expect(at("i1")).toMatchObject({
            fromSec: 30,
            toSec: 40,
            spotSec: 30,
            padSec: listen.tone.leadSec + SPEAKER_PAD_SEC,
        });
        // The line at 40 runs to 60: a single time hears at most 15 s of it.
        expect(at("i2")).toMatchObject({ fromSec: 40, toSec: 55 });
        expect(at("i3")).toMatchObject({ fromSec: 20, toSec: 30 });
        // A stretch of a second or more is the asker's own span.
        expect(at("i4")).toMatchObject({ fromSec: 30, toSec: 40 });
    });

    test("a voice asked at one instant stops where another speaker starts, inside the time span's minimum too", () => {
        const turns: TranscriptEntry[] = [
            { speaker: "Speaker 1", startSec: 10, text: "Začneme." },
            { speaker: "Speaker 2", startSec: 30, text: "Jo." },
            { speaker: "Speaker 1", startSec: 32, text: "Dobře, dál." },
            { speaker: "Speaker 2", startSec: 50, text: "Ano." },
            { speaker: "Speaker 2", startSec: 52, text: "Ještě něco." },
            { speaker: "Speaker 1", startSec: 70, text: "Konec." },
        ];
        const instant = record([
            { id: "i1", kind: "speaker-range", label: "Speaker 2", fromSec: 30, toSec: 30 },
            { id: "i2", kind: "speaker-range", label: "Speaker 2", fromSec: 50, toSec: 50 },
        ]);
        const at = (id: string) =>
            planMoment({ record: instant, transcript: turns, listen, target: { kind: "item", id } });

        // Speaker 1 starts at 32: the four-second minimum would play two seconds of the other voice.
        expect(at("i1")).toMatchObject({ fromSec: 30, toSec: 32 });
        // The same voice goes on at 52: the minimum still reaches into it.
        expect(at("i2")).toMatchObject({ fromSec: 50, toSec: 54 });
    });

    test("a removal hears the line it would remove, not only the pads around the line's start", () => {
        // An automatic removal is the start of its line: fromSec and toSec are the same time.
        const removals = record([
            {
                id: "i1",
                kind: "removal",
                fromSec: 20,
                toSec: 20,
                heard: "Dej to do Ada a pak taky do zadání, prosím.",
                evidence: { reason: "local speech output", transcriptLine: 1 },
            },
        ]);

        expect(planMoment({ record: removals, transcript, listen, target: { kind: "item", id: "i1" } })).toMatchObject({
            fromSec: 20,
            toSec: 30,
            spotSec: 20,
            padSec: listen.tone.leadSec + SPEAKER_PAD_SEC,
        });
    });
});

describe("a term's spot from the meeting's word timings (U11)", () => {
    /** "Ada" stands at character 10 of the 43 in the line spoken from 20 s to 30 s: its text estimates 22.33 s. */
    const estimatedAda = 20 + (10 / 43) * 10;
    /** The same lines as the word timings read them: "Ada" is said at 26.2 s. */
    const timedLines = transcript.map((entry) =>
        entry.startSec === 20
            ? { ...entry, words: [{ range: { location: 10, length: 3 }, startSec: 26.2, endSec: 26.6 }] }
            : entry
    );

    test("a term's spot is the start of its word in the word timings, and its clip and tone follow it", () => {
        const target: MomentTarget = { kind: "item", id: "i3" };
        const timed = planMoment({ record: meeting, transcript, listen, target, wordTimedLines: timedLines });

        expect(plan(target).spotSec).toBeCloseTo(estimatedAda, 5);
        expect(timed.spotSec).toBe(26.2);
        expect(timed.fromSec).toBeCloseTo(26.2 - 1.5, 5);
        expect(timed.toSec).toBeCloseTo(26.2 + 2.5, 5);
        expect(timed.tone?.atSec).toBeCloseTo(26.2 - listen.tone.leadSec, 5);
    });

    test("an applied spelling finds its word too: the timed line reads the proposed spelling", () => {
        const renamed = record([{ id: "i9", kind: "term", atSec: 20, heard: "Ada", proposed: "Adaline" }]);
        const applied = transcript.map((entry) =>
            entry.startSec === 20
                ? {
                      ...entry,
                      text: entry.text.replace("Ada", "Adaline"),
                      words: [
                          { range: { location: 0, length: 3 }, startSec: 20.1, endSec: 20.4 },
                          { range: { location: 10, length: 7 }, startSec: 26.2, endSec: 26.9 },
                      ],
                  }
                : entry
        );

        expect(
            planMoment({
                record: renamed,
                transcript,
                listen,
                target: { kind: "item", id: "i9" },
                wordTimedLines: applied,
            }).spotSec
        ).toBe(26.2);
    });

    test("word timings that do not cover the term's line leave the estimate from its text", () => {
        const elsewhere = transcript.map((entry) =>
            entry.startSec === 30
                ? { ...entry, words: [{ range: { location: 0, length: 2 }, startSec: 30.2, endSec: 30.4 }] }
                : entry
        );

        expect(
            planMoment({
                record: meeting,
                transcript,
                listen,
                target: { kind: "item", id: "i3" },
                wordTimedLines: elsewhere,
            }).spotSec
        ).toBeCloseTo(estimatedAda, 5);
    });

    test("simultaneous lines do not borrow another line's word timing", () => {
        const turns = [transcript[1]!, ...transcript];
        const target: MomentTarget = { kind: "item", id: "i9" };
        const selected = record([{ id: "i9", kind: "term", atSec: 20, heard: "Ada", evidence: { transcriptLine: 2 } }]);
        const options = { record: selected, transcript: turns, listen, target };
        expect(planMoment({ ...options, wordTimedLines: timedLines }).spotSec).toBe(planMoment(options).spotSec);
    });

    test("a saved meeting's term takes its spot from the meeting's cached word timings", async () => {
        const audioPath = recording("word-timed-term");
        const store = new MeetingStore(new Storage("meetings-moment-word-timed"));
        const saved = await store.create(
            {
                title: "Word timed planning",
                start: now,
                createdBy: "new",
                sources: { wisprflow: { meetingId: "abc" } },
                items: meeting.items,
            },
            { command: "new", change: "test" }
        );
        const opened = OpenedMeeting.of(store, saved, { source: fakeSource(audioPath), sourceMeetingId: "abc" });
        const target: MomentTarget = { kind: "item", id: "i3" };
        const estimated = await openMoment({ store, record: saved, target, opened, screen: false });
        const cache = meetingWordTimingCache(saved.id);
        const model = join(dirname(audioPath), "weights.onnx");
        writeFileSync(model, "model weights");
        const { applied } = await correctedTranscriptRead({
            store,
            record: saved,
            format: "json",
            flags: { dictionary: true },
            opened,
        });
        await cache.publish(
            makeWordTimingArtifact({
                window: { fromSec: 20, toSec: 30 },
                audio: wordTimingFile(audioPath),
                modelFiles: [wordTimingFile(model)],
                modelId: "test/word-model",
                pcmSha256: "test-pcm",
                // Times from the window's start: "Ada" is said 6.2 s into the line.
                words: [
                    { text: "Dej", startSec: 0.1, endSec: 0.4 },
                    { text: "to", startSec: 0.5, endSec: 0.7 },
                    { text: "do", startSec: 0.8, endSec: 1 },
                    { text: "Ada", startSec: 6.2, endSec: 6.6 },
                    { text: "a", startSec: 6.8, endSec: 6.9 },
                    { text: "pak", startSec: 7, endSec: 7.3 },
                    { text: "taky", startSec: 7.4, endSec: 7.7 },
                    { text: "do", startSec: 7.8, endSec: 7.9 },
                    { text: "zadání", startSec: 8, endSec: 8.6 },
                    { text: "prosím", startSec: 8.8, endSec: 9.3 },
                ],
                lines: timedTranscriptView(saved, applied).entries,
            })
        );

        try {
            const timed = await openMoment({ store, record: saved, target, opened, screen: false });

            expect(estimated.spotSec).toBeCloseTo(estimatedAda, 5);
            expect(timed.spotSec).toBeCloseTo(26.2, 5);
        } finally {
            rmSync(cache.folder, { recursive: true, force: true });
        }
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

    test("the pads before and after a span are their own settings; equal pads keep the one padSec (decision 9)", () => {
        const split = meetingsConfigSchema.parse({
            version: 5,
            global: { playback: { listen: { padBeforeSec: 2, padAfterSec: 6 } } },
        }).global.playback.listen;
        const range = plan({ kind: "range", fromSec: 30, toSec: 35 }, split);

        expect(range).toMatchObject({ padSec: 2, padAfterSec: 6, startSec: 28, endSec: 41 });
        expect(clipPlan(range)).toMatchObject({ padSec: 2, padAfterSec: 6 });
        // A voice keeps the tone's lead on both sides, whatever the pads.
        expect(plan({ kind: "item", id: "i2" }, split).padAfterSec).toBeUndefined();

        const before = meetingsConfigSchema.parse({
            version: 5,
            global: { playback: { listen: { padBeforeSec: 3 } } },
        });
        const one = plan({ kind: "range", fromSec: 30, toSec: 35 }, before.global.playback.listen);
        expect(one).toMatchObject({ padSec: 3, startSec: 27, endSec: 38 });
        expect(one.padAfterSec).toBeUndefined();

        // A caller's padSec is both sides, and its padAfterSec the after side only.
        const rolling = planMoment({
            record: meeting,
            transcript,
            listen: split,
            target: { kind: "range", fromSec: 30, toSec: 35 },
            padSec: 0,
        });
        expect(rolling).toMatchObject({ padSec: 0, startSec: 30, endSec: 35 });
        const after = planMoment({
            record: meeting,
            transcript,
            listen: split,
            target: { kind: "range", fromSec: 30, toSec: 35 },
            padAfterSec: 1,
        });
        expect(after).toMatchObject({ padSec: 2, padAfterSec: 1, endSec: 36 });
    });

    test("an unavailable tone uses an explicit beep policy and retains the requested volume", async () => {
        const folder = mkdtempSync(join(tmpdir(), "mtg-tone-policy-"));
        const file = join(folder, "missing.wav");
        const sound = await resolveToneSound(
            { file, volume: 0.23 },
            {
                probe: async () => {
                    throw new Error("must not probe a missing file");
                },
                onMissing: "beep",
            }
        );
        expect(sound).toMatchObject({ hz: 880, sec: 0.15, volume: 0.23, preset: "beep" });
        expect(sound.fallback).toContain("Using a beep");
        await expect(
            resolveToneSound(
                { file, volume: 0.23 },
                {
                    probe: async () => ({ durationSec: 1 }),
                    onMissing: "error",
                }
            )
        ).rejects.toThrow("is not there");
        writeFileSync(file, "invalid sound");
        const invalid = await resolveToneSound(
            { file, volume: 0.4 },
            {
                probe: async () => ({ durationSec: Number.NaN }),
                onMissing: "beep",
            }
        );
        expect(invalid.fallback).toContain("Using a beep");
        const failed = await resolveToneSound(
            { file, volume: 0.4 },
            {
                probe: async () => {
                    throw new Error("decoder failed");
                },
                onMissing: "beep",
            }
        );
        expect(failed.fallback).toContain("Using a beep");
        const repaired = await resolveToneSound(
            { file, volume: 0.4 },
            {
                probe: async () => ({ durationSec: 0.7 }),
                onMissing: "beep",
            }
        );
        expect(repaired).toEqual({ hz: 0, sec: 0.7, volume: 0.4, file });
    });

    test("a tone path that is not a regular file is refused before ffprobe starts", async () => {
        const folder = mkdtempSync(join(tmpdir(), "mtg-tone-not-file-"));
        let probed = false;
        await expect(
            resolveToneSound(
                { file: folder, volume: 0.5 },
                {
                    probe: async () => {
                        probed = true;
                        return { durationSec: 1 };
                    },
                    onMissing: "error",
                }
            )
        ).rejects.toThrow("is not a regular file");
        expect(probed).toBe(false);
    });

    test("a preset or a sound file is the tone's sound; a file's length is read once and cut to 2 s (decision 8)", async () => {
        const soft = meetingsConfigSchema.parse({
            version: 5,
            global: { playback: { listen: { tone: { sound: { preset: "soft", volume: 0.3 } } } } },
        }).global.playback.listen;
        expect(plan({ kind: "item", id: "i1" }, soft).tone?.sound).toEqual({
            hz: 523,
            sec: 0.3,
            volume: 0.3,
            preset: "soft",
        });

        const file = join(mkdtempSync(join(tmpdir(), "mtg-tone-")), "chime.wav");
        writeFileSync(file, "RIFF");
        const chime = meetingsConfigSchema.parse({
            version: 5,
            global: { playback: { listen: { tone: { sound: { file } } } } },
        }).global.playback.listen;
        // A file's length comes from the file, so the planner refuses to guess it.
        expect(() => plan({ kind: "item", id: "i1" }, chime)).toThrow("resolve it with resolveToneSound");

        let probes = 0;
        const probe = async () => {
            probes += 1;
            return { durationSec: 3.4567 };
        };
        const sound = await resolveToneSound(chime.tone.sound, { probe });
        expect(sound).toEqual({ hz: 0, sec: TONE_MAX_SEC, volume: 0.6, file });
        await resolveToneSound(chime.tone.sound, { probe });
        expect(probes).toBe(1);
        const moment = planMoment({
            record: meeting,
            transcript,
            listen: chime,
            target: { kind: "item", id: "i1" },
            toneSound: sound,
        });
        expect(moment.tone?.sound).toEqual(sound);
        expect(clipPlan(moment).toneSound).toEqual(sound);
        // An edited tone file is a new clip key, so a cached clip never keeps the old sound.
        const source = { path: "/clips/call.ogg", mtimeMs: 1, size: 2 };
        const cached = momentCachePath(moment, source);
        writeFileSync(file, "RIFF, longer");
        expect(momentCachePath(moment, source)).not.toBe(cached);

        await expect(
            resolveToneSound({ file: join(dirname(file), "gone.wav"), volume: 0.6 }, { probe })
        ).rejects.toThrow("is not there");
        expect(() =>
            meetingsConfigSchema.parse({
                version: 5,
                global: { playback: { listen: { tone: { sound: { preset: "gong" } } } } },
            })
        ).toThrow();
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

    test('"at 10:00 and 10:30" names two times; "between 10:00 and 10:30" names a range', () => {
        expect(momentsInText("said at 10:00 and 10:30").map((one) => one.target)).toEqual([
            { kind: "time", atSec: 600 },
            { kind: "time", atSec: 630 },
        ]);
        expect(momentsInText("between 10:00 and 10:30").map((one) => one.target)).toEqual([
            { kind: "range", fromSec: 600, toSec: 630 },
        ]);
    });

    test("explicit wall-clock cues stay plain while recording timestamps remain playable", () => {
        for (const text of [
            "Was this decided at the 14:30 standup?",
            "The 2:30 pm call",
            "14:30 CET",
            "14:30 schůzka",
        ]) {
            expect(momentsInText(text)).toEqual([]);
        }
        expect(momentsInText("At 14:30 in the recording, discuss the 2:30 pm call").map((one) => one.target)).toEqual([
            { kind: "time", atSec: 870 },
        ]);
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

    test("an old clip's place in the meeting folder: the same Moment one file, another span or tone another", () => {
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
            pads: { beforeSec: 5, afterSec: 5 },
            audioAt: async () => ({ path: "/clips/call.ogg", offsetMs: 0 }),
            dir: "/clips/out",
            cut: async () => {},
        });
        const silent = meetingsConfigSchema.parse({ global: { playback: { listen: { tone: { enabled: false } } } } });
        const [quiet] = await writeQuestionClips({
            record: meeting,
            questions: [question("i2")],
            transcript,
            listen: silent.global.playback.listen,
            pads: { beforeSec: 5, afterSec: 5 },
            audioAt: async () => ({ path: "/clips/call.ogg", offsetMs: 0 }),
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
            toSec: 60,
            padSec: listen.tone.leadSec + SPEAKER_PAD_SEC,
            toneAtSec: 30 - listen.tone.leadSec,
        });
        expect(Object.keys(quiet!)).toEqual(["question", "id", "clip", "fromSec", "toSec", "padSec"]);
        // Split pads add padAfterSec after padSec; equal pads print as before.
        const [split] = await writeQuestionClips({
            record: meeting,
            questions: [question("i1")],
            transcript,
            listen,
            pads: { beforeSec: 2, afterSec: 6 },
            audioAt: async () => ({ path: "/clips/call.ogg", offsetMs: 0 }),
            dir: "/clips/out",
            cut: async () => {},
        });
        expect(Object.keys(split!)).toEqual([
            "question",
            "id",
            "clip",
            "fromSec",
            "toSec",
            "padSec",
            "padAfterSec",
            "toneAtSec",
        ]);
        expect(split).toMatchObject({ padSec: 2, padAfterSec: 6 });
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

    test("the words' block comes from the rows the screen lookup read: ocr.jsonl is not read a second time", async () => {
        const store = new MeetingStore(new Storage("meetings-moment-screen-hit"));
        const at = (sec: number) => new Date(Date.parse(now) + sec * 1000).toISOString();
        const recorded = meetingRecordSchema.parse({
            ...meeting,
            recording: { status: "stopped", spans: [{ from: at(0), to: at(120) }] },
        });
        const folder = store.folder(recorded.id);
        mkdirSync(folder, { recursive: true });
        const bounds = { x: 1, y: 2, width: 3, height: 4 };
        const rows = [
            { file: "frames/a.jpg", at: at(5), displayId: 1, text: "Agenda", blocks: [] },
            {
                file: "frames/c.jpg",
                at: at(40),
                displayId: 1,
                text: "Budget plan",
                blocks: [{ text: "Budget plan", confidence: 1, bounds }],
            },
        ];
        writeFileSync(join(folder, "ocr.jsonl"), rows.map((row) => SafeJSON.stringify(row)).join("\n"));
        const reads = spyOn(screenBoxes, "readOcrRows");

        try {
            expect(await momentFrames(store, recorded, 45, ["budget"])).toEqual([
                {
                    file: "frames/c.jpg",
                    path: join(folder, "frames/c.jpg"),
                    at: at(40),
                    meetingSec: 40,
                    displayId: 1,
                    hit: { text: "Budget plan", box: bounds },
                },
            ]);
            // Once, by the screen lookup itself.
            expect(reads).toHaveBeenCalledTimes(1);
        } finally {
            reads.mockRestore();
        }
    });
});

/** A source that answers this file's transcript and keeps the recording at `audioPath`. */
function fakeSource(audioPath: string, entries = transcript): TranscriptSource {
    const sourceMeeting: SourceMeeting = {
        sourceMeetingId: "abc",
        title: "Planning",
        start: now,
        participants: [],
        speakers: [],
        transcript: entries,
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
        meetingsBetween: async () => null,
        meetingFolders: async () => [],
        folderWrite: { supported: false, reason: "fake", manualStep: "none" },
    };
}

/** A recording file of its own per test: the clip cache keys a clip by the recording's path, time and size. */
function recording(name: string): string {
    const dir = mkdtempSync(join(tmpdir(), "moment-audio-"));
    const path = join(dir, `${name}.ogg`);
    writeFileSync(path, `audio of ${name}`);
    return path;
}

async function savedMeeting(storage: string, audioPath: string, fixture = { items: meeting.items, transcript }) {
    const store = new MeetingStore(new Storage(storage));
    const saved = await store.create(
        {
            title: "Planning",
            start: now,
            createdBy: "new",
            sources: { wisprflow: { meetingId: "abc" } },
            items: fixture.items,
        },
        { command: "new", change: "test" }
    );
    const opened = OpenedMeeting.of(store, saved, {
        source: fakeSource(audioPath, fixture.transcript),
        sourceMeetingId: "abc",
    });
    return { store, saved, opened };
}

const oneTrack = async () => ({ tracks: 1 });

describe("a Moment of a saved meeting", () => {
    test("the terminal and window cut every decided speaker line and name the intervening audio", async () => {
        const turns = [
            { speaker: "Voice A", startSec: 10, text: "First sentence." },
            { speaker: "Voice A", startSec: 20, text: "Second sentence." },
            { speaker: "Voice B", startSec: 24, text: "Another discussion." },
            { speaker: "Voice A", startSec: 60, text: "Last sentence." },
        ];
        const items = record([
            { id: "i1", kind: "speaker-range", label: "Voice A", fromSec: 10, toSec: 20 },
            { id: "i2", kind: "speaker-range", label: "Voice A", fromSec: 60, toSec: 60 },
            {
                id: "i3",
                kind: "question",
                about: "speaker",
                question: "Who speaks?",
                fromSec: 10,
                toSec: 20,
                clip: { fromSec: 10, toSec: 20 },
                decides: ["i2", "i1"],
            },
        ]).items;
        const audioPath = recording("decided-lines");
        const { store, saved, opened } = await savedMeeting("meetings-moment-decided", audioPath, {
            items,
            transcript: turns,
        });
        const question = saved.items.find((item): item is QuestionItem => item.kind === "question")!;
        const cuts: Array<Parameters<typeof cutClip>[0]> = [];
        const cut: typeof cutClip = async (options) => {
            cuts.push(options);
            writeFileSync(options.outPath, "RIFF");
        };
        const expected = { fromSec: 10, toSec: 65, gapNote: "Also plays intervening audio 00:24–01:00" };
        const terminal = await writeQuestionClips({
            record: saved,
            questions: [question],
            transcript: turns,
            listen,
            pads: { beforeSec: 0, afterSec: 0 },
            audioAt: async () => ({ path: audioPath, offsetMs: 0 }),
            dir: dirname(audioPath),
            cut,
        });
        const native = await clipMoment({
            store,
            record: saved,
            opened,
            target: { kind: "item", id: "Q1" },
            cut,
            probe: oneTrack,
        });
        expect(terminal[0]).toMatchObject(expected);
        expect(native).toMatchObject(expected);
        expect(cuts.map(({ fromSec, toSec }) => [fromSec, toSec])).toEqual([
            [10, 65],
            [10, 65],
        ]);
        expect(question.clip).toEqual({ fromSec: 10, toSec: 20 });

        const adjacent = questionClip({
            record: saved,
            question: { ...question, decides: ["i1"] },
            transcript: turns,
            listen,
            pads: { beforeSec: 0, afterSec: 0 },
        });
        expect(adjacent).toMatchObject({ fromSec: 10, toSec: 24 });
        expect(adjacent).not.toHaveProperty("gapNote");
    });

    test("a speaker question keeps its own last line when its only decided target is elsewhere", () => {
        const saved = record([
            { id: "i1", kind: "speaker-range", label: "Speaker 1", fromSec: 60, toSec: 60 },
            {
                id: "i2",
                kind: "question",
                about: "speaker",
                question: "Who speaks?",
                fromSec: 10,
                toSec: 20,
                decides: ["i1"],
            },
        ]);
        const input = { record: saved, transcript, listen, target: { kind: "item" as const, id: "i2" } };
        expect(planMoment(input)).toMatchObject({
            fromSec: 10,
            toSec: 65,
            gapNote: "Also plays intervening audio 00:30–01:00",
        });
        expect(planMoment({ ...input, lengthSec: 5 })).not.toHaveProperty("gapNote");
    });

    test("a question ending at its decided line's known end leaves the next voice out", () => {
        const saved = record([
            { id: "i1", kind: "speaker-range", label: "Speaker 1", fromSec: 10, toSec: 20, evidence: { endSec: 30 } },
            {
                id: "i2",
                kind: "question",
                about: "speaker",
                question: "Who speaks?",
                fromSec: 10,
                toSec: 30,
                clip: { fromSec: 10, toSec: 20 },
                decides: ["i1"],
            },
        ]);
        expect(planMoment({ record: saved, transcript, listen, target: { kind: "item", id: "i2" } })).toMatchObject({
            fromSec: 10,
            toSec: 30,
        });
    });

    test("its source transcript and the saved settings make the Moment, its clip goes to the cache once", async () => {
        const audioPath = recording("saved");
        const { store, saved, opened } = await savedMeeting("meetings-moment-saved", audioPath);
        const target: MomentTarget = { kind: "item", id: "Q1" };
        const cuts: Array<Parameters<typeof cutClip>[0]> = [];
        const cutter = async (options: Parameters<typeof cutClip>[0]) => {
            cuts.push(options);
            mkdirSync(dirname(options.outPath), { recursive: true });
            writeFileSync(options.outPath, "RIFF");
        };
        const cut = await clipMoment({ store, record: saved, target, opened, cut: cutter, probe: oneTrack });
        const again = await clipMoment({ store, record: saved, target, opened, cut: cutter, probe: oneTrack });
        const planned = planMoment({ record: saved, transcript, listen, target });

        expect(await openMoment({ store, record: saved, target, opened })).toEqual({ ...planned, meeting: saved.id });
        expect(cut.path).toStartWith(join(momentCacheDir(saved.id), "Q1-"));
        expect(again).toEqual(cut);
        // The cut writes beside the clip, and the clip takes its place once it is whole; the second play cuts nothing.
        expect(cuts).toEqual([{ audioPath, outPath: expect.any(String), ...clipPlan(planned), tracks: 1 }]);
        expect(dirname(cuts[0]!.outPath)).toBe(dirname(cut.path));
        expect(cuts[0]!.outPath).not.toBe(cut.path);
        expect(readFileSync(cut.path, "utf8")).toBe("RIFF");
    });

    test("a tone the caller names sounds for that call even when the tone setting is off (play --tone)", async () => {
        const { store, saved, opened } = await savedMeeting("meetings-moment-tone-off", recording("tone-off"));
        const off = meetingsConfigSchema.parse({
            version: 5,
            global: { playback: { listen: { tone: { enabled: false } } } },
        });
        spyOn(opened, "config").mockResolvedValue(off);
        const target: MomentTarget = { kind: "item", id: "Q1" };

        expect((await openMoment({ store, record: saved, target, opened })).tone).toBeUndefined();
        const named = await openMoment({ store, record: saved, target, opened, toneSound: { preset: "soft" } });
        expect(named.tone?.sound).toEqual({ hz: 523, sec: 0.3, volume: 0.35, preset: "soft" });
        expect(named.tone?.atSec).toBe(
            (await openMoment({ store, record: saved, target, opened, toneSound: { preset: "beep" } })).tone?.atSec
        );
    });

    test("a saved missing-tone choice controls planning without changing the sound preference", async () => {
        const { store, saved, opened } = await savedMeeting("meetings-moment-fallback", recording("fallback"));
        const config = meetingsConfigSchema.parse({
            global: { playback: { listen: { tone: { sound: { file: "/missing/tone.wav", volume: 0.2 } } } } },
        });
        spyOn(opened, "config").mockResolvedValue(config);
        const options = { store, record: saved, target: { kind: "item" as const, id: "Q1" }, opened, screen: false };
        const result = await openMoment(options);
        expect(result.tone?.sound).toMatchObject({ preset: "beep", volume: 0.2 });
        expect(result.tone?.sound.fallback).toContain("Using a beep");
        expect(config.global.playback.listen.tone.sound).toEqual({ file: "/missing/tone.wav", volume: 0.2 });
        config.global.playback.listen.tone.onMissing = "error";
        await expect(openMoment(options)).rejects.toThrow("is not there");
    });

    test("Wave E: an explicit silent Moment never resolves a tone or changes the saved setting", async () => {
        const { store, saved, opened } = await savedMeeting("meetings-moment-silent", recording("silent"));
        const config = meetingsConfigSchema.parse({
            version: 5,
            global: { playback: { listen: { tone: { enabled: true, sound: { file: "/missing/tone.wav" } } } } },
        });
        spyOn(opened, "config").mockResolvedValue(config);
        const probeTone = async () => {
            throw new Error("a silent Moment must not read its tone file");
        };
        const result = await openMoment({
            store,
            record: saved,
            target: { kind: "item", id: "Q1" },
            opened,
            tone: false,
            toneSound: { file: "/missing/explicit.wav", volume: 0.6 },
            probeTone,
        });
        expect(result.tone).toBeUndefined();
        expect(config.global.playback.listen.tone.enabled).toBe(true);
        expect(config.global.playback.listen.tone.sound).toEqual({ file: "/missing/tone.wav", volume: 0.6 });
    });

    test("clips made before source-clock preservation are not reused", async () => {
        const audioPath = recording("old-clock-cache");
        const { store, saved, opened } = await savedMeeting("meetings-moment-old-clock", audioPath);
        const target: MomentTarget = { kind: "item", id: "Q1" };
        const planned = await openMoment({ store, record: saved, target, opened });
        const source = statSync(audioPath);
        const oldKey = Bun.hash(
            SafeJSON.stringify([
                planned.startSec,
                planned.endSec,
                planned.tone ?? null,
                audioPath,
                source.mtimeMs,
                source.size,
            ])
        ).toString(36);
        const oldPath = join(momentCacheDir(saved.id), `Q1-${oldKey}.wav`);
        mkdirSync(dirname(oldPath), { recursive: true });
        writeFileSync(oldPath, "old shifted clock");
        let cuts = 0;
        const result = await clipMoment({
            store,
            record: saved,
            target,
            opened,
            probe: oneTrack,
            cut: async (options) => {
                cuts++;
                writeFileSync(options.outPath, "new source clock");
            },
        });
        expect(cuts).toBe(1);
        expect(result.path).not.toBe(oldPath);
        expect(readFileSync(result.path, "utf8")).toBe("new source clock");
        expect(readFileSync(oldPath, "utf8")).toBe("old shifted clock");
    });

    test("cancel during the track probe does not fall back to a one-track cut", async () => {
        const { store, saved, opened } = await savedMeeting("meetings-moment-probe-cancel", recording("probe-cancel"));
        const controller = new AbortController();
        let cuts = 0;
        await expect(
            clipMoment({
                store,
                record: saved,
                target: { kind: "item", id: "Q2" },
                opened,
                control: { signal: controller.signal },
                probe: async (_path, options) => {
                    expect(options?.signal).toBe(controller.signal);
                    controller.abort(new Error("cancel track probe"));
                    throw controller.signal.reason;
                },
                cut: async () => {
                    cuts++;
                },
            })
        ).rejects.toThrow("cancel track probe");
        expect(cuts).toBe(0);
    });

    test("a recording with two tracks is cut with both, and another recording file is another clip", async () => {
        const { store, saved, opened } = await savedMeeting("meetings-moment-tracks", recording("tracks"));
        const cuts: Array<Parameters<typeof cutClip>[0]> = [];
        const cut = await clipMoment({
            store,
            record: saved,
            target: { kind: "item", id: "Q2" },
            opened,
            probe: async () => ({ tracks: 2 }),
            cut: async (options) => {
                cuts.push(options);
                writeFileSync(options.outPath, "RIFF");
            },
        });
        const other = momentCachePath(cut, { path: "/elsewhere/call.ogg", mtimeMs: 1, size: 2 });

        expect(cuts.map((one) => one.tracks)).toEqual([2]);
        expect(other).not.toBe(cut.path);
        expect(dirname(other)).toBe(dirname(cut.path));
    });

    // The window plays the clip at its path while a second play, or an agent's `play --clip`, cuts the same Moment.
    test("two cuts of one Moment at once never leave a half-written clip where a player reads it", async () => {
        const { store, saved, opened } = await savedMeeting("meetings-moment-recut", recording("recut"));
        const target: MomentTarget = { kind: "item", id: "Q1" };
        const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
        const started = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
        // Writes the clip as ffmpeg does: the header first, the samples once its gate opens.
        const writer = (n: number) => async (options: { outPath: string }) => {
            mkdirSync(dirname(options.outPath), { recursive: true });
            writeFileSync(options.outPath, "RIFF");
            started[n]!.resolve();
            await gates[n]!.promise;
            appendFileSync(options.outPath, `-${n}`);
        };
        const first = clipMoment({ store, record: saved, target, opened, cut: writer(0), probe: oneTrack });
        const second = clipMoment({ store, record: saved, target, opened, cut: writer(1), probe: oneTrack });
        await Promise.all(started.map((one) => one.promise));
        gates[0]!.resolve();
        const path = (await first).path;
        expect(readFileSync(path, "utf8")).toBe("RIFF-0");
        gates[1]!.resolve();
        expect((await second).path).toBe(path);
        expect(readFileSync(path, "utf8")).toBe("RIFF-1");

        // A cut that fails leaves no partial file beside the clips.
        const failing = clipMoment({
            store,
            record: saved,
            target: { kind: "item", id: "Q2" },
            opened,
            probe: oneTrack,
            cut: async (options) => {
                writeFileSync(options.outPath, "RIFF");
                throw new Error("ffmpeg failed");
            },
        });
        await expect(failing).rejects.toThrow("ffmpeg failed");
        // The cache folder is the meeting's, which other tests' clips share: no hidden partial file is left in it.
        expect(readdirSync(dirname(path)).filter((name) => name.startsWith("."))).toEqual([]);
        expect(readdirSync(dirname(path))).toContain(basename(path));
    });

    test("the cache keeps at most its cap, removing the clips used longest ago and never a cut in progress", () => {
        const root = mkdtempSync(join(tmpdir(), "moment-cache-"));
        mkdirSync(join(root, "m1"));
        const write = (name: string, bytes: number, ageSec: number) => {
            const path = join(root, "m1", name);
            writeFileSync(path, "x".repeat(bytes));
            const when = new Date(Date.now() - ageSec * 1000);
            utimesSync(path, when, when);
        };
        write("old.wav", 400, 300);
        write("mid.wav", 400, 200);
        write("new.wav", 400, 100);
        write(".cutting-1.wav", 400, 400);

        expect(trimMomentCache({ capBytes: 900, root })).toBe(1);
        expect(readdirSync(join(root, "m1")).sort()).toEqual([".cutting-1.wav", "mid.wav", "new.wav"]);
    });

    test("the cache never removes the clip it is trimmed for, even when that clip alone is over the cap", () => {
        const root = mkdtempSync(join(tmpdir(), "moment-cache-"));
        mkdirSync(join(root, "m1"));
        const old = join(root, "m1", "old.wav");
        const big = join(root, "m1", "big.wav");
        writeFileSync(old, "x".repeat(400));
        const before = new Date(Date.now() - 300_000);
        utimesSync(old, before, before);
        writeFileSync(big, "x".repeat(1000));

        expect(trimMomentCache({ capBytes: 900, root, keep: big })).toBe(1);
        expect(readdirSync(join(root, "m1"))).toEqual(["big.wav"]);
    });

    test("a cache folder that cannot be listed is skipped: trimming never fails the clip it runs after", () => {
        const root = mkdtempSync(join(tmpdir(), "moment-cache-"));
        mkdirSync(join(root, "m1"));
        writeFileSync(join(root, "m1", "old.wav"), "x".repeat(1000));
        const locked = join(root, "locked");
        mkdirSync(locked);
        chmodSync(locked, 0o000);

        try {
            expect(trimMomentCache({ capBytes: 900, root })).toBe(1);
        } finally {
            chmodSync(locked, 0o755);
        }

        // A root that is not a folder lists nothing.
        expect(trimMomentCache({ capBytes: 0, root: join(root, "m1", "gone", "x") })).toBe(0);
        writeFileSync(join(root, "plain"), "x");
        expect(trimMomentCache({ capBytes: 0, root: join(root, "plain") })).toBe(0);
    });
});

describe("a Moment that is too long, and the frame that shows its words", () => {
    test("an item or a speaker turn longer than longestClipSec plays its first longestClipSec, and says so; a range is the caller's", () => {
        const short = meetingsConfigSchema.parse({ global: { playback: { listen: { longestClipSec: 5 } } } });
        const long = record([{ id: "i9", kind: "speaker-range", label: "Speaker 2", fromSec: 30, toSec: 50 }]);
        const planLong = (target: MomentTarget) =>
            planMoment({ record: long, transcript, listen: short.global.playback.listen, target });

        const item = planLong({ kind: "item", id: "i9" });
        expect(item).toMatchObject({ fromSec: 30, toSec: 35 });
        expect(item.label).toContain("(first 5 s of 00:20)");
        expect(
            planLong({ kind: "stretch", atSec: 30 }).toSec - planLong({ kind: "stretch", atSec: 30 }).fromSec
        ).toBeLessThanOrEqual(5);
        expect(planLong({ kind: "range", fromSec: 30, toSec: 50 }).toSec).toBe(50);
        expect(listen.longestClipSec).toBe(30);
    });

    test("the frame whose OCR text shows a term's words comes first, with the block's text and box", async () => {
        const store = new MeetingStore(new Storage("meetings-moment-hit"));
        const at = (sec: number) => new Date(Date.parse(now) + sec * 1000).toISOString();
        const recorded = meetingRecordSchema.parse({
            ...meeting,
            recording: { status: "stopped", spans: [{ from: at(0), to: at(120) }] },
        });
        const folder = store.folder(recorded.id);
        mkdirSync(folder, { recursive: true });
        const box = { x: 0.1, y: 0.2, width: 0.3, height: 0.05 };
        const rows = [
            { file: "frames/a.jpg", at: at(5), displayId: 1, text: "Agenda", blocks: [] },
            {
                file: "frames/b.jpg",
                at: at(8),
                displayId: 2,
                text: "ADA notes",
                blocks: [{ text: "ADA notes", confidence: 1, bounds: box }],
            },
        ];
        writeFileSync(join(folder, "ocr.jsonl"), rows.map((row) => SafeJSON.stringify(row)).join("\n"));

        const frames = await momentFrames(store, recorded, 30, ["ADA"]);
        expect(frames.map((frame) => [frame.file, frame.hit])).toEqual([
            ["frames/b.jpg", { text: "ADA notes", box }],
            ["frames/a.jpg", undefined],
        ]);
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

    test("--target is checked against the Moment targets before any meeting is read", async () => {
        expect(await refusal("m1", "--target", "{nope")).toEqual(["--target is not JSON: {nope"]);
        const [line] = await refusal("m1", "--target", '{"kind":"range","fromSec":-1,"toSec":5}');
        expect(line).toStartWith("--target is not a Moment target (");
    });
});

test("split clips keep accepted acoustic word boundaries and at least one and a half seconds before them", async () => {
    const saved = record([
        {
            id: "i1",
            kind: "question",
            about: "speaker",
            fromSec: 10,
            toSec: 14,
            question: 'Who says "Second sentence"?',
        },
    ]);
    const question = saved.items[0] as QuestionItem;
    const timed = [
        {
            speaker: "Voice",
            startSec: 10,
            text: "First sentence. Second sentence",
            words: [
                { range: { location: 16, length: 6 }, startSec: 12.3, endSec: 12.6, sourceId: "fixture" },
                { range: { location: 23, length: 8 }, startSec: 12.7, endSec: 13.1, sourceId: "fixture" },
            ],
        },
    ];
    const plan = questionClip({
        record: saved,
        question,
        transcript: timed,
        listen,
        pads: { beforeSec: 0, afterSec: 0 },
    });
    expect(plan).toMatchObject({ fromSec: 12.3, toSec: 13.1, padSec: 1.5, wordTimed: true });
    // No audio access is needed for an accepted boundary.
    expect(await refineSplitClip({ plan, question, audioPath: "/unreadable.wav" })).toEqual(plan);
    const audioPath = recording("word-timed-part");
    const fixture = await savedMeeting("meetings-moment-word-part", audioPath, {
        items: saved.items,
        transcript: timed,
    });
    const native = await clipMoment({
        store: fixture.store,
        record: fixture.saved,
        opened: fixture.opened,
        target: { kind: "item", id: "Q1" },
        probe: oneTrack,
        cut: async ({ outPath }) => {
            writeFileSync(outPath, "RIFF");
        },
    });
    expect(native).toMatchObject({ fromSec: 12.3, toSec: 13.1, padSec: 1.5, startSec: 12.3 - 1.5 });
});

test("a Who says clip reads the word timing cache with the corrected lines the cache was published for", async () => {
    const saved = record([
        {
            id: "i1",
            kind: "question",
            about: "speaker",
            fromSec: 10,
            toSec: 14,
            question: 'Who says "Second sentence"?',
        },
    ]);
    const audioPath = recording("word-cache-part");
    const fixture = await savedMeeting("meetings-moment-word-cache-part", audioPath, {
        items: saved.items,
        transcript: [
            { speaker: "Voice", startSec: 10, text: "First sentence. Second sentence" },
            { speaker: "Voice", startSec: 20, text: "Next." },
        ],
    });
    const cache = meetingWordTimingCache(fixture.saved.id);
    const model = join(dirname(audioPath), "weights.onnx");
    writeFileSync(model, "model weights");
    const { applied } = await correctedTranscriptRead({
        store: fixture.store,
        record: fixture.saved,
        format: "json",
        flags: { dictionary: true },
        opened: fixture.opened,
    });
    await cache.publish(
        makeWordTimingArtifact({
            window: { fromSec: 10, toSec: 20 },
            audio: wordTimingFile(audioPath),
            modelFiles: [wordTimingFile(model)],
            modelId: "test/word-model",
            pcmSha256: "test-pcm",
            words: [
                { text: "First", startSec: 0.1, endSec: 0.5 },
                { text: "sentence", startSec: 0.6, endSec: 1 },
                { text: "Second", startSec: 2.3, endSec: 2.6 },
                { text: "sentence", startSec: 2.7, endSec: 3.1 },
            ],
            lines: timedTranscriptView(fixture.saved, applied).entries,
        })
    );

    try {
        const clip = await clipMoment({
            store: fixture.store,
            record: fixture.saved,
            opened: fixture.opened,
            target: { kind: "item", id: "Q1" },
            probe: oneTrack,
            cut: async ({ outPath }) => {
                writeFileSync(outPath, "RIFF");
            },
        });
        expect(clip).toMatchObject({ fromSec: 12.3, toSec: 13.1, padSec: 1.5 });
    } finally {
        rmSync(cache.folder, { recursive: true, force: true });
    }
});

test("manual clip pause holds its position and resumes the same process without replaying", () => {
    let clock = 1000;
    const signals: Array<string | number | undefined> = [];
    const now = spyOn(Date, "now").mockImplementation(() => clock);
    const fake = {
        exitCode: null,
        exited: new Promise<number>(() => {}),
        kill: (signal?: string | number) => {
            signals.push(signal);
        },
    };
    const spawn = spyOn(Bun, "spawn").mockImplementation(() => fake as unknown as ReturnType<typeof Bun.spawn>);
    try {
        const clip = playClip("afplay", "/fixture-never-played.wav");
        clock = 2500;
        clip.pause();
        clock = 5000;
        expect(clip.positionSec).toBe(1.5);
        clip.resume();
        clock = 6000;
        expect(clip.positionSec).toBe(2.5);
        clip.stop();
        expect(clip.positionSec).toBe(2.5);
        expect(signals).toEqual(["SIGSTOP", "SIGCONT", undefined]);
        expect(spawn).toHaveBeenCalledTimes(1);
    } finally {
        spawn.mockRestore();
        now.mockRestore();
    }
});

describe("a joined meeting is one record of sound (join --repair moves the later recording in)", () => {
    const LATER = "2026-11-09_10-10-later";
    const at = (sec: number) => new Date(Date.parse(now) + sec * 1000).toISOString();
    const row = (file: string, sec: number) =>
        SafeJSON.stringify({
            file: `audio/${file}`,
            source: "mic",
            at: at(sec),
            zeroAt: at(sec),
            durationMs: 60_000,
            mutedSpans: [],
        });
    const clock = (correctionSec: number) =>
        SafeJSON.stringify({ version: 1, sources: { mic: { correctionSec, pieces: 4, clear: 3 } } });
    /** The joined record's own copy: the first recording's source and both meeting ids. */
    const joinedRef = { sourceId: "wisprflow", sourceMeetingId: "abc+def" };

    /** One recording's own source: "def" speaks with labels of its own, so the two recordings may join. */
    function recordingFake(sourceMeetingId: string): TranscriptSource {
        const entries =
            sourceMeetingId === "abc"
                ? transcript
                : transcript.map((entry) => ({ ...entry, speaker: entry.speaker.replace("Speaker", "Host") }));
        const startedAt = at(sourceMeetingId === "abc" ? 0 : 600);
        return {
            ...fakeSource("", entries),
            load: async () => ({
                sourceMeetingId,
                title: "Planning",
                start: startedAt,
                participants: [],
                speakers: [],
                transcript: entries,
                folders: [],
            }),
            evidence: async () => ({ selfName: "Alice Example", segments: [], speaking: [], files: [] }),
            recordingClock: async () => ({ startedAt }),
        };
    }

    /** Opens each recording's fake source and counts the opens: a read of a joined record must make none. */
    function recordingOpener() {
        const opened: string[] = [];
        const open = async (recording: { sourceMeetingId: string }) => {
            opened.push(recording.sourceMeetingId);
            return recordingFake(recording.sourceMeetingId);
        };
        return { open, opened };
    }

    /**
     * A meeting joined the way the join wrote it before 2026-11-25: the earlier recording's sound in the joined folder,
     * the later recording (600 s on) still in its own folder with its recorder piece, rows, clock and source file.
     */
    async function oldJoin(storage: string, layouts: Array<"left-mic" | "right-mic" | undefined> = []) {
        const store = new MeetingStore(new Storage(storage));
        const created = await store.create(
            {
                title: "Planning",
                start: now,
                createdBy: "new",
                sources: { wisprflow: { meetingId: "abc" } },
                items: meeting.items,
            },
            { command: "new", change: "test" }
        );
        const keptFolder = store.folder(created.id);
        const laterFolder = store.folder(LATER);
        const sound = (folder: string, name: string, body: string) => {
            mkdirSync(join(folder, "source-audio"), { recursive: true });
            const path = join(folder, "source-audio", `${name}.ogg`);
            writeFileSync(path, body);
            return {
                sourceMeetingId: name === "a".repeat(64) ? "abc" : "def",
                path,
                sha256: name,
                bytes: Buffer.byteLength(body),
                savedAt: now,
            };
        };
        const earlier = sound(keptFolder, "a".repeat(64), "the earlier recording");
        const later = sound(laterFolder, "b".repeat(64), "the later recording, a longer file");

        for (const [folder, file, sec, correction] of [
            [keptFolder, "s1-audio-000001-mic.m4a", 2, -0.48],
            [laterFolder, "s2-audio-000001-mic.m4a", 603, -0.11],
        ] as const) {
            mkdirSync(join(folder, "audio"), { recursive: true });
            mkdirSync(join(folder, "evidence"), { recursive: true });
            writeFileSync(join(folder, "audio", file), "recorder piece");
            writeFileSync(join(folder, "audio.jsonl"), `${row(file, sec)}\n`);
            writeFileSync(join(folder, "evidence", "sound-clock.json"), clock(correction));
        }

        writeFileSync(join(laterFolder, "joined-into.json"), SafeJSON.stringify({ joinedInto: created.id }));
        const part = (record: string, offsetMs: number, endSec: number, audio: typeof earlier, index: number) => ({
            ...(layouts[index] ? { channels: { layout: layouts[index], segments: { mic: 30, system: 30 } } } : {}),
            record,
            title: "Planning",
            sourceId: "wisprflow",
            sourceMeetingId: audio.sourceMeetingId,
            zeroAt: at(offsetMs / 1000),
            offsetMs,
            endSec,
            audio,
        });
        const record = await store.update(created.id, { command: "join", change: "test" }, (next) => {
            next.version = JOINED_RECORD_VERSION;
            next.join = {
                version: 1,
                at: now,
                backup: "/fixture/backup",
                parts: [part(created.id, 0, 65, earlier, 0), part(LATER, 600_000, 665, later, 1)],
            };
            next.audio = { sources: { wisprflow: earlier } };
        });
        const listing = () =>
            [keptFolder, laterFolder].flatMap((folder) =>
                readdirSync(folder, { recursive: true }).map((name) => join(folder, String(name)))
            );
        return {
            store,
            record,
            keptFolder,
            laterFolder,
            files: { earlier: earlier.path, later: later.path },
            listing,
            ...recordingOpener(),
        };
    }

    const encodes: Array<{ inputs: ReadonlyArray<{ path: string; offsetMs: number }> }> = [];
    const encode = async (options: { inputs: ReadonlyArray<{ path: string; offsetMs: number }>; outPath: string }) => {
        encodes.push({ inputs: options.inputs });
        writeFileSync(options.outPath, "the whole meeting");
    };

    test("before the repair no reader takes its sound; a dry run moves nothing; the repair runs once", async () => {
        const fx = await oldJoin(`meetings-joined-repair-${process.pid}`);
        const backupRoot = mkdtempSync(join(tmpdir(), "joined-repair-"));
        const before = fx.listing();

        await expect(OpenedMeeting.of(fx.store, fx.record).audioPath()).rejects.toThrow(
            `join ${fx.record.id} --repair`
        );
        const dry = await repairJoin({ store: fx.store, ref: fx.record.id, open: fx.open, dryRun: true });
        expect(dry).toMatchObject({
            repaired: false,
            sound: { pieces: 1, rows: 1, recordings: [{ offsetMs: 0 }, { record: LATER, offsetMs: 600_000 }] },
        });
        expect(fx.listing()).toEqual(before);

        const done = await repairJoin({ store: fx.store, ref: fx.record.id, open: fx.open, backupRoot, encode });
        const again = await repairJoin({ store: fx.store, ref: fx.record.id, open: fx.open, backupRoot, encode });
        const record = fx.store.read(fx.record.id)!;
        const moved = (name: string) => join(fx.keptFolder, "source-audio", `${name.repeat(64)}.ogg`);

        expect(done).toMatchObject({ repaired: true, sound: { pieces: 1, rows: 1 } });
        expect(again).toEqual({
            meeting: fx.record.id,
            dryRun: false,
            repaired: false,
            reason: "its sound and its transcript are in its own folder already",
        });
        expect(encodes.at(-1)?.inputs).toEqual([
            { path: fx.files.earlier, offsetMs: 0 },
            { path: fx.files.later, offsetMs: 600_000 },
        ]);
        expect(record.join?.version).toBe(2);
        expect(record.audio?.sources.wisprflow).toMatchObject({
            sourceMeetingId: "abc",
            path: done.joinedFile,
            pieces: [
                { path: moved("a"), offsetMs: 0 },
                { path: moved("b"), offsetMs: 600_000 },
            ],
        });
        // The later folder keeps only the marker that resolves its old id; everything else is in the backup.
        expect(readdirSync(fx.laterFolder)).toEqual(["joined-into.json"]);
        expect(readdirSync(join(fx.keptFolder, "audio")).sort()).toEqual([
            "s1-audio-000001-mic.m4a",
            "s2-audio-000001-mic.m4a",
        ]);
        expect(readdirSync(join(done.backup!, "before")).sort()).toEqual([fx.record.id, LATER].sort());
    });

    test("each recording keeps its own channel layout: source-mic is the microphone side of both", async () => {
        const fx = await oldJoin(`meetings-joined-layout-${process.pid}`, ["left-mic", "right-mic"]);
        const done = await repairJoin({
            store: fx.store,
            ref: fx.record.id,
            open: fx.open,
            backupRoot: mkdtempSync(join(tmpdir(), "joined-layout-")),
            encode,
        });
        const record = fx.store.read(fx.record.id)!;
        const opened = OpenedMeeting.of(fx.store, record, {
            source: fakeSource(done.joinedFile ?? "", transcript),
            sourceMeetingId: "abc",
        });
        const tracks = (await opened.sound()).tracks;
        const channels = (kind: string) =>
            tracks.find((track) => track.kind === kind)?.pieces.map((piece) => piece.channel);

        expect(record.audio?.sources.wisprflow?.pieces?.map((piece) => piece.layout)).toEqual([
            "left-mic",
            "right-mic",
        ]);
        expect(channels("source-mic")).toEqual([0, 1]);
        expect(channels("source-call")).toEqual([1, 0]);
        expect(
            (await opened.sound()).slice({
                seat: "mic",
                fromSec: 620,
                toSec: 630,
                purpose: "listen",
                track: "source-mic",
            })
        ).toMatchObject({
            channel: 1,
            fileFromSec: 20,
        });
    });

    test("after the repair a range is cut from the recording that holds it, on its own seconds; one over the gap from the one file", async () => {
        const fx = await oldJoin(`meetings-joined-clip-${process.pid}`);
        const backupRoot = mkdtempSync(join(tmpdir(), "joined-clip-"));
        const done = await repairJoin({ store: fx.store, ref: fx.record.id, open: fx.open, backupRoot, encode });
        const record = fx.store.read(fx.record.id)!;
        const joined = [
            ...transcript,
            ...transcript.map((entry) => ({ ...entry, startSec: (entry.startSec ?? 0) + 600 })),
        ];
        const joinedFile = done.joinedFile ?? "";
        const opened = () =>
            OpenedMeeting.of(fx.store, record, { source: fakeSource(joinedFile, joined), sourceMeetingId: "abc" });
        const laterFile = join(fx.keptFolder, "source-audio", `${"b".repeat(64)}.ogg`);
        const earlierFile = join(fx.keptFolder, "source-audio", `${"a".repeat(64)}.ogg`);
        const cuts: Array<Parameters<typeof cutClip>[0]> = [];
        const cut = async (options: Parameters<typeof cutClip>[0]) => {
            cuts.push(options);
            writeFileSync(options.outPath, "RIFF");
        };
        const range = (fromSec: number, toSec: number) => ({ kind: "range" as const, fromSec, toSec });
        const clip = (target: MomentTarget) =>
            clipMoment({
                store: fx.store,
                record,
                target,
                opened: opened(),
                cut,
                probe: oneTrack,
                screen: false,
                tone: false,
            });

        expect(await opened().audioAt(620, 630)).toEqual({ path: laterFile, offsetMs: 600_000 });
        expect(await opened().audioAt(20, 30)).toEqual({ path: earlierFile, offsetMs: 0 });
        expect(await opened().audioAt(50, 620)).toEqual({ path: joinedFile, offsetMs: 0 });
        expect(await opened().audioPath()).toBe(joinedFile);

        const later = await clip(range(620, 630));
        await clip(range(20, 30));
        await clip(range(50, 620));
        expect(later).toMatchObject({ meeting: record.id, fromSec: 620, toSec: 630 });
        expect(cuts.map((one) => [one.audioPath, one.fromSec, one.toSec])).toEqual([
            [laterFile, 20, 30],
            [earlierFile, 20, 30],
            [joinedFile, 50, 620],
        ]);

        // Each recording keeps its own measured clock: the earlier piece moves by -0.48 s, the later one by -0.11 s.
        const mic = (await opened().sound()).tracks.find((track) => track.kind === "mic-raw");
        expect(mic?.clock).toBe("measured");
        expect(mic?.pieces.map((piece) => Math.round(piece.zeroSec * 1000) / 1000)).toEqual([1.52, 602.89]);
        const source = (await opened().sound()).tracks.find((track) => track.kind === "source-mic");
        expect(source?.pieces.map((piece) => [piece.path, piece.zeroSec])).toEqual([
            [earlierFile, 0],
            [laterFile, 600],
        ]);
    });

    /** The provider's own copies of both recordings, older than what the record saved, as the watcher lists them. */
    function providerFiles(fx: Awaited<ReturnType<typeof oldJoin>>) {
        const dir = mkdtempSync(join(tmpdir(), "joined-provider-"));
        const old = new Date(Date.parse(now) - 3_600_000);
        return [
            { sourceMeetingId: "abc", from: fx.files.earlier },
            { sourceMeetingId: "def", from: fx.files.later },
        ].map(({ sourceMeetingId, from }) => {
            const path = join(dir, `${sourceMeetingId}.ogg`);
            writeFileSync(path, readFileSync(from));
            utimesSync(path, old, old);
            return { sourceMeetingId, path };
        });
    }

    test("a source-audio pass over a joined record copies nothing: each recording it holds reads as kept", async () => {
        const fx = await oldJoin(`meetings-joined-watch-${process.pid}`);
        const provider = providerFiles(fx);
        await repairJoin({
            store: fx.store,
            ref: fx.record.id,
            open: fx.open,
            backupRoot: mkdtempSync(join(tmpdir(), "joined-watch-")),
            encode,
        });
        const before = SafeJSON.stringify(fx.store.read(fx.record.id));
        const source = {
            id: "wisprflow" as const,
            files: async () => provider,
            legacyFiles: async () => [],
            load: async () => null,
        };

        const record = fx.store.read(fx.record.id)!;
        expect(preservedSourceAudio(record, { sourceId: "wisprflow", sourceMeetingId: "def" })?.path).toBe(
            join(fx.keptFolder, "source-audio", `${"b".repeat(64)}.ogg`)
        );
        expect(recordSourceAudio(record)?.pieces).toHaveLength(2);
        for (let pass = 0; pass < 3; pass++) {
            expect(await discoverSourceAudio({ store: fx.store, source })).toEqual({ preserved: 0, pending: 0 });
        }
        expect(SafeJSON.stringify(fx.store.read(fx.record.id))).toBe(before);
        // A preserve that reached it anyway never puts one recording over the file of the whole meeting.
        await expect(
            preserveSourceAudio({
                store: fx.store,
                meetingId: fx.record.id,
                ref: { sourceId: "wisprflow", sourceMeetingId: "abc" },
                sourcePath: provider[0]!.path,
            })
        ).rejects.toThrow("--repair");
        expect(SafeJSON.stringify(fx.store.read(fx.record.id))).toBe(before);
    });

    test("the repair keeps the joined transcript as the record's own copy: no read asks a recording, a second repair writes nothing", async () => {
        const fx = await oldJoin(`meetings-joined-copy-${process.pid}`);
        const backupRoot = mkdtempSync(join(tmpdir(), "joined-copy-"));
        const done = await repairJoin({ store: fx.store, ref: fx.record.id, open: fx.open, backupRoot, encode });
        const copy = readSourceCopy(fx.keptFolder, "meeting", joinedRef);

        expect(done.transcript).toEqual({ lines: 10 });
        expect(copy?.value.transcript.map((line) => [line.speaker, line.startSec, line.sourceMeetingId])).toEqual([
            ...transcript.map((line) => [line.speaker, line.startSec, "abc"]),
            ...transcript.map((line) => [line.speaker.replace("Speaker", "Host"), (line.startSec ?? 0) + 600, "def"]),
        ]);
        expect(readSourceCopy(fx.keptFolder, "evidence", joinedRef)?.value?.selfName).toBe("Alice Example");
        expect(readSourceCopy(fx.keptFolder, "clock", joinedRef)?.value).toEqual({ startedAt: at(0) });

        const record = fx.store.read(fx.record.id)!;
        const opens = fx.opened.length;
        expect((await OpenedMeeting.of(fx.store, record).meeting()).transcript).toEqual(copy!.value.transcript);
        expect(await localMeetingTranscript(record, fx.store)).toEqual(copy!.value.transcript);
        expect(fx.opened).toHaveLength(opens);
        expect(record.history.at(-1)?.change).toContain("the joined transcript (10 lines)");

        // Each recording keeps its own copy beside the joined one: its own lines, labels and clock, as it answered alone.
        for (const [index, id] of ["abc", "def"].entries()) {
            const part = record.join!.parts[index]!;
            const holder = recordingCopyHolder(fx.store, part, record.id);
            const own = await recordingFake(id).load(id);
            const lost: TranscriptSource = {
                ...recordingFake(id),
                load: () => Promise.reject(new Error(`the provider lost ${id}`)),
                recordingClock: () => Promise.reject(new Error(`the provider lost ${id}`)),
            };

            expect(holder).toBe(recordingCopyFolder(fx.keptFolder, id));
            expect(await copyBackedSource(lost, holder, { save: false }).load(id)).toEqual(own);
            expect(await copyBackedSource(lost, holder, { save: false }).recordingClock(id)).toEqual({
                startedAt: at(index * 600),
            });
        }

        const listing = fx.listing();
        const again = await repairJoin({ store: fx.store, ref: fx.record.id, open: fx.open, backupRoot, encode });
        expect(again).toMatchObject({
            repaired: false,
            reason: "its sound and its transcript are in its own folder already",
        });
        expect(readSourceCopy(fx.keptFolder, "meeting", joinedRef)?.savedAt).toBe(copy?.savedAt);
        expect(fx.listing()).toEqual(listing);
        expect(fx.store.read(fx.record.id)?.history).toEqual(record.history);
    });

    test("a recording that cannot be read leaves the record as it was: the repair writes nothing", async () => {
        const fx = await oldJoin(`meetings-joined-unread-${process.pid}`);
        const before = fx.listing();
        const gone = async (recording: { sourceMeetingId: string }) =>
            recording.sourceMeetingId === "def"
                ? { ...recordingFake("def"), load: () => Promise.reject(new Error("the provider lost def")) }
                : recordingFake(recording.sourceMeetingId);
        const backupRoot = mkdtempSync(join(tmpdir(), "joined-unread-"));

        // Before the repair the record keeps no transcript to read: it is never composed from the recordings again.
        await expect(OpenedMeeting.of(fx.store, fx.record).meeting()).rejects.toThrow(`join ${fx.record.id} --repair`);
        await expect(localMeetingTranscript(fx.record, fx.store)).rejects.toThrow(`join ${fx.record.id} --repair`);
        await expect(
            repairJoin({ store: fx.store, ref: fx.record.id, open: gone, backupRoot, encode })
        ).rejects.toThrow("the provider lost def");
        expect(fx.listing()).toEqual(before);
        expect(readdirSync(backupRoot)).toEqual([]);
    });

    test("join reads each recording once and keeps the joined transcript as the record's own copy", async () => {
        const store = new MeetingStore(new Storage(`meetings-join-copy-${process.pid}`));
        const recorded = async (meetingId: string, startSec: number, sha: string) => {
            const created = await store.create(
                { title: "Planning", start: at(startSec), createdBy: "new", sources: { wisprflow: { meetingId } } },
                { command: "new", change: "test" }
            );
            const folder = store.folder(created.id);
            const body = `the recording of ${meetingId}`;
            mkdirSync(join(folder, "source-audio"), { recursive: true });
            const path = join(folder, "source-audio", `${sha}.ogg`);
            writeFileSync(path, body);
            return store.update(created.id, { command: "audio preserve", change: "test" }, (next) => {
                const audio = {
                    sourceMeetingId: meetingId,
                    path,
                    sha256: sha,
                    bytes: Buffer.byteLength(body),
                    savedAt: now,
                };
                next.audio = { sources: { wisprflow: audio } };
            });
        };
        const earlier = await recorded("abc", 0, "a".repeat(64));
        const later = await recorded("def", 600, "b".repeat(64));
        const { open: own, opened } = recordingOpener();
        // Both recordings number their speakers alike: the later one's labels read as "Speaker 1 (2)" once joined.
        const open = async (recording: { sourceMeetingId: string }) => {
            const source = await own(recording);
            const meeting = await source.load(recording.sourceMeetingId);
            return { ...source, load: async () => ({ ...meeting, transcript }) };
        };
        const result = await joinMeetings({
            store,
            ids: [earlier.id, later.id],
            backupRoot: mkdtempSync(join(tmpdir(), "join-copy-")),
            encode,
            open,
        });
        const copy = readSourceCopy(store.folder(earlier.id), "meeting", joinedRef);

        expect(result.transcript).toEqual({ lines: 10, copied: true });
        expect(copy?.value.transcript.map((line) => line.startSec)).toEqual([
            10, 20, 30, 40, 60, 610, 620, 630, 640, 660,
        ]);
        const joined = store.read(earlier.id)!;
        // The copy carries the joined numbering (the later recording's first line is line 5) and the joined labels.
        expect(joined.join?.parts.map((part) => part.firstLine)).toEqual([0, 5]);
        expect(copy?.value.transcript.slice(4, 6).map((line) => [line.speaker, line.sourceMeetingId])).toEqual([
            ["Speaker 1", "abc"],
            ["Speaker 1 (2)", "def"],
        ]);
        const opens = opened.length;
        expect((await OpenedMeeting.of(store, joined).meeting()).transcript).toEqual(copy!.value.transcript);
        expect(opened).toHaveLength(opens);
        expect(await repairJoin({ store, ref: joined.id, open, encode })).toMatchObject({ repaired: false });
    });

    test("repair writes a source slot a recording was copied over again, once, and keeps the lost file in the backup", async () => {
        const fx = await oldJoin(`meetings-joined-slot-${process.pid}`);
        const backupRoot = mkdtempSync(join(tmpdir(), "joined-slot-"));
        const first = await repairJoin({ store: fx.store, ref: fx.record.id, open: fx.open, backupRoot, encode });
        const merged = fx.store.read(fx.record.id)!;
        const later = merged.audio!.sources.wisprflow!.pieces![1]!;
        // What the source-audio pass of the earlier build left: the later recording alone in the slot.
        await fx.store.update(fx.record.id, { command: "audio preserve", change: "test" }, (next) => {
            const { sourceMeetingId, path, sha256, bytes, savedAt } = later;
            next.audio = { sources: { wisprflow: { sourceMeetingId, path, sha256, bytes, savedAt } } };
        });
        const broken = SafeJSON.stringify(fx.store.read(fx.record.id));
        // Until the repair, a source-audio pass still copies no recording over it: the preserve refuses a joined record.
        await expect(
            preserveSourceAudio({
                store: fx.store,
                meetingId: fx.record.id,
                ref: { sourceId: "wisprflow", sourceMeetingId: "abc" },
                sourcePath: fx.files.earlier,
            })
        ).rejects.toThrow("--repair");
        expect(SafeJSON.stringify(fx.store.read(fx.record.id))).toBe(broken);

        const dry = await repairJoin({
            store: fx.store,
            ref: fx.record.id,
            open: fx.open,
            backupRoot,
            dryRun: true,
            encode,
        });
        expect(dry).toMatchObject({ repaired: false, slot: expect.stringContaining("the recording of def") });
        expect(SafeJSON.stringify(fx.store.read(fx.record.id))).toBe(broken);

        const done = await repairJoin({
            store: fx.store,
            ref: fx.record.id,
            open: fx.open,
            backupRoot,
            encode,
            now: new Date(Date.parse(now) + 120_000),
        });
        const again = await repairJoin({ store: fx.store, ref: fx.record.id, open: fx.open, backupRoot, encode });
        const slot = fx.store.read(fx.record.id)!.audio!.sources.wisprflow!;
        expect(done).toMatchObject({ repaired: true, slot: expect.stringContaining("the recording of def") });
        expect(again).toMatchObject({
            repaired: false,
            reason: "its sound and its transcript are in its own folder already",
        });
        expect(slot).toMatchObject({ sourceMeetingId: "abc", path: done.joinedFile });
        expect(slot.pieces?.map((piece) => [piece.sourceMeetingId, piece.offsetMs])).toEqual([
            ["abc", 0],
            ["def", 600_000],
        ]);
        // The file of the whole meeting the slot lost is not left beside the new one.
        const lost = first.joinedFile!;
        expect(existsSync(lost) && lost !== done.joinedFile).toBe(false);
    });
});

describe("joining two recordings that both have a Speaker 1", () => {
    const at = (sec: number) => new Date(Date.parse(now) + sec * 1000).toISOString();
    const sources: Record<string, SourceMeeting> = {
        early: {
            sourceMeetingId: "early",
            title: "Planning",
            start: at(0),
            participants: [],
            speakers: [{ name: "Speaker 1" }, { name: "Speaker 2" }],
            transcript: [
                { speaker: "Speaker 1", startSec: 5, text: "First." },
                { speaker: "Speaker 2", startSec: 20, text: "Second." },
            ],
            folders: [],
        },
        late: {
            sourceMeetingId: "late",
            title: "Planning",
            start: at(600),
            participants: [],
            speakers: [{ name: "Speaker 1" }, { name: "Speaker 3" }],
            transcript: [
                { speaker: "Speaker 1", startSec: 4, text: "Later." },
                { speaker: "Speaker 3", startSec: 30, text: "Other." },
            ],
            folders: [],
        },
    };

    test("the later one's lines, items and names read as Speaker 1 (2), and its own reading as Speaker 1 again", async () => {
        const store = new MeetingStore(new Storage(`meetings-join-relabel-${process.pid}`));
        const spies = [
            spyOn(wisprflowSource, "load").mockImplementation(async (id) => sources[id]!),
            spyOn(wisprflowSource, "recordingClock").mockImplementation(async (id) => ({
                startedAt: sources[id]!.start,
            })),
            spyOn(wisprflowSource, "evidence").mockResolvedValue(null),
            spyOn(wisprflowSource, "revision").mockResolvedValue(null),
        ];
        const range = (label: string, person: string, fromSec: number) => ({
            id: "i1",
            kind: "speaker-range" as const,
            label,
            fromSec,
            toSec: fromSec + 5,
            speaker: person,
            status: "suggested" as const,
            confidence: 0.8,
            rules: ["presence"],
            suggestedAt: now,
        });
        const recording = async (meetingId: string, person: string, fromSec: number) => {
            const created = await store.create(
                {
                    title: "Planning",
                    start: sources[meetingId]!.start,
                    createdBy: "new",
                    sources: { wisprflow: { meetingId } },
                },
                { command: "new", change: "test" }
            );
            return store.update(created.id, { command: "test", change: "names" }, (next) => {
                next.speakers = {
                    labels: { "Speaker 1": person },
                    assignments: [{ id: "a1", label: "Speaker 1", fromSec, toSec: fromSec + 5, person, at: now }],
                };
                next.items = [range("Speaker 1", person, fromSec)];
            });
        };

        try {
            const early = await recording("early", "Alice Example", 5);
            const late = await recording("late", "Bob Example", 4);
            const result = await joinMeetings({
                store,
                ids: [late.id, early.id],
                backupRoot: mkdtempSync(join(tmpdir(), "join-relabel-")),
            });
            const joined = store.read(early.id)!;

            // The backup holds both recordings as they were, so the relabel undoes with the join.
            expect(result.parts.map((part) => part.relabeled)).toEqual([undefined, { "Speaker 1": "Speaker 1 (2)" }]);
            expect(existsSync(join(result.backup!, "before", late.id, "meeting.json"))).toBe(true);
            expect(joined.join?.parts.map((part) => part.speakerLabels)).toEqual([
                undefined,
                { "Speaker 1": "Speaker 1 (2)" },
            ]);
            expect(joined.speakers.labels).toEqual({ "Speaker 1": "Alice Example", "Speaker 1 (2)": "Bob Example" });
            expect(joined.speakers.assignments?.map((one) => [one.label, one.person, one.fromSec])).toEqual([
                ["Speaker 1", "Alice Example", 5],
                ["Speaker 1 (2)", "Bob Example", 604],
            ]);
            expect(joined.items.map((item) => ("label" in item ? [item.label, item.fromSec] : []))).toEqual([
                ["Speaker 1", 5],
                ["Speaker 1 (2)", 604],
            ]);

            const opened = OpenedMeeting.of(store, joined);
            const transcript = (await opened.meeting()).transcript;
            expect(transcript.map((line) => [line.speaker, line.startSec])).toEqual([
                ["Speaker 1", 5],
                ["Speaker 2", 20],
                ["Speaker 1 (2)", 604],
                ["Speaker 3", 630],
            ]);

            // The later recording read alone (a polished file) has its own label and its own person under it.
            const own = opened.recordingReading(late.id)!.opened.record;
            expect(own.speakers.labels["Speaker 1"]).toBe("Bob Example");
            expect(own.items.map((item) => ("label" in item ? [item.label, item.fromSec] : []))).toEqual([
                ["Speaker 1", 4],
            ]);
        } finally {
            for (const spy of spies) {
                spy.mockRestore();
            }
        }
    });
});

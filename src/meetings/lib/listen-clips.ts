import { join } from "node:path";
import { toFloat32AudioWindow } from "@genesiscz/utils/audio/converter";
import { ui } from "@genesiscz/utils/cli/ui";
import type { ListenPads } from "@genesiscz/utils/meetings/config";
import type { MeetingRecord } from "@genesiscz/utils/meetings/record";
import type { TranscriptLines } from "@genesiscz/utils/transcribe/lines";
import { TranscriptLines as Lines } from "@genesiscz/utils/transcribe/lines";
import type { TranscriptEntry } from "@genesiscz/utils/transcribe/types";
import { type ClipPlan, cutClip, probeAudio } from "./audio";
import { clipPlan, itemMoment, type ListenSettings } from "./moment";
import { type QuestionItem, questionLabel } from "./questions";
import { resolveToneSound, type ToneSound } from "./tone-sound";
import { meetingWordTimingCache } from "./word-timings";

export type { ClipPlan } from "./audio";
export { type ListenSettings, SPEAKER_PAD_SEC } from "./moment";

/** What every clip of one `listen` run shares: the settings, the pads, and the tone's sound read once. */
export interface ClipSettings {
    listen: ListenSettings;
    pads: ListenPads;
    /** The tone's sound (`resolveToneSound`); absent when the tone is off. */
    toneSound?: ToneSound;
}

/** The clip settings of a run: a sound file's length is read here once, not for each question. */
export async function clipSettings(listen: ListenSettings, pads: ListenPads): Promise<ClipSettings> {
    const toneSound = listen.tone.enabled
        ? await resolveToneSound(listen.tone.sound, { probe: probeAudio, onMissing: listen.tone.onMissing })
        : undefined;
    if (toneSound?.fallback) {
        ui.warn(toneSound.fallback);
    }
    return { listen, pads, ...(toneSound ? { toneSound } : {}) };
}

/**
 * The clip of one question, the same for the terminal and for `listen --clip-out`: the question's Moment (moment.ts)
 * as `cutClip` takes it. A word question plays the spot of its own occurrence, a speaker question only the asked
 * voice from the tone on, and a word keeps the pads of audio before and after it.
 */
export function questionClip(
    options: {
        record: MeetingRecord;
        question: QuestionItem;
        transcript: readonly TranscriptEntry[] | TranscriptLines;
    } & ClipSettings
): ClipPlan {
    const { question, pads, toneSound, ...input } = options;
    const entries = options.transcript instanceof Lines ? options.transcript.entries : options.transcript;
    const quote = question.question.match(/^Who says "(.+)"/s)?.[1];
    if (quote) {
        const timed = entries.some((line) => line.words?.length)
            ? entries
            : meetingWordTimingCache(options.record.id).read(entries).entries;
        for (const line of timed) {
            const start = line.text.indexOf(quote);
            const first = line.words?.find(
                (word) => word.range.location >= start && word.range.location < start + quote.length
            );
            const last = line.words?.findLast(
                (word) => word.range.location < start + quote.length && word.range.location >= start
            );
            if (
                start >= 0 &&
                first &&
                last &&
                line.startSec !== undefined &&
                line.startSec <= question.toSec &&
                (line.startSec === question.fromSec || first.startSec >= question.fromSec - 1.5)
            ) {
                const plan = clipPlan(
                    itemMoment({
                        ...input,
                        item: question,
                        padSec: Math.max(1.5, pads.beforeSec),
                        padAfterSec: pads.afterSec,
                        ...(toneSound ? { toneSound } : {}),
                    })
                );
                return {
                    ...plan,
                    wordTimed: true,
                    fromSec: first.startSec,
                    toSec: last.endSec,
                    padSec: Math.max(1.5, plan.padSec),
                };
            }
        }
    }
    return clipPlan(
        itemMoment({
            ...input,
            item: question,
            padSec: pads.beforeSec,
            padAfterSec: pads.afterSec,
            ...(toneSound ? { toneSound } : {}),
        })
    );
}

/** One line of `listen --clip-out --json`. Its keys are a contract: new ones may be added, none removed or renamed. */
export async function refineSplitClip(options: {
    plan: ClipPlan;
    question: QuestionItem;
    audioPath: string;
}): Promise<ClipPlan> {
    if (!options.question.question.startsWith('Who says "') || options.plan.fromSec <= 0 || options.plan.wordTimed) {
        return options.plan;
    }
    const from = Math.max(0, options.plan.fromSec - 1.5);
    const samples = await toFloat32AudioWindow(options.audioPath, { fromSec: from, toSec: options.plan.fromSec + 0.1 });
    const frame = 1600;
    let best = Infinity;
    let at = options.plan.fromSec;
    for (let offset = 0; offset + frame <= samples.length; offset += frame) {
        let energy = 0;
        for (let index = offset; index < offset + frame; index++) {
            energy += samples[index]! ** 2;
        }
        if (energy / frame < 0.015 ** 2 && energy < best) {
            best = energy;
            at = from + offset / 16000;
        }
    }
    return { ...options.plan, fromSec: at, padSec: Math.max(1.5, options.plan.padSec) };
}

export interface WrittenClip {
    /** The question's number as `listen` and `items` show it (Q12). */
    question: string;
    id: string;
    clip: string;
    fromSec: number;
    toSec: number;
    padSec: number;
    /** The pad after the stretch, only when it differs from `padSec` (`playback.listen.padAfterSec`). */
    padAfterSec?: number;
    toneAtSec?: number;
}

/**
 * `listen --clip-out <dir>`: each question's clip as `<dir>/<Q12>.wav`, cut as the terminal would play it. Nothing plays,
 * no round starts and the record is not changed, so an agent or a test can check a clip without sound (MC22).
 */
export async function writeQuestionClips(
    options: {
        record: MeetingRecord;
        questions: QuestionItem[];
        transcript: readonly TranscriptEntry[] | TranscriptLines;
        audioPath: string;
        dir: string;
        cut?: typeof cutClip;
    } & ClipSettings
): Promise<WrittenClip[]> {
    const cut = options.cut ?? cutClip;
    const written: WrittenClip[] = [];

    for (const question of options.questions) {
        const label = questionLabel(options.record, question.id);
        const plan = await refineSplitClip({
            plan: questionClip({ ...options, question }),
            question,
            audioPath: options.audioPath,
        });
        const clip = join(options.dir, `${label}.wav`);
        await cut({ audioPath: options.audioPath, outPath: clip, ...plan });
        written.push({
            question: label,
            id: question.id,
            clip,
            fromSec: plan.fromSec,
            toSec: plan.toSec,
            padSec: plan.padSec,
            ...(plan.padAfterSec === undefined ? {} : { padAfterSec: plan.padAfterSec }),
            ...(plan.toneAtSec === undefined ? {} : { toneAtSec: plan.toneAtSec }),
        });
    }

    return written;
}

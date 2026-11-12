import { join } from "node:path";
import { ui } from "@genesiscz/utils/cli/ui";
import type { ListenPads } from "@genesiscz/utils/meetings/config";
import type { MeetingRecord } from "@genesiscz/utils/meetings/record";
import type { TranscriptLines } from "@genesiscz/utils/transcribe/lines";
import type { TranscriptEntry } from "@genesiscz/utils/transcribe/types";
import { type ClipPlan, cutClip, probeAudio } from "./audio";
import { clipPlan, itemMoment, type ListenSettings } from "./moment";
import { type QuestionItem, questionLabel } from "./questions";
import { resolveToneSound, type ToneSound } from "./tone-sound";

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
        const plan = questionClip({ ...options, question });
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

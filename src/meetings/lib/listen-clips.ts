import { join } from "node:path";
import type { MeetingRecord } from "@genesiscz/utils/meetings/record";
import type { TranscriptLines } from "@genesiscz/utils/transcribe/lines";
import type { TranscriptEntry } from "@genesiscz/utils/transcribe/types";
import { type ClipPlan, cutClip } from "./audio";
import { clipPlan, itemMoment, type ListenSettings } from "./moment";
import { type QuestionItem, questionLabel } from "./questions";

export type { ClipPlan } from "./audio";
export { type ListenSettings, SPEAKER_PAD_SEC } from "./moment";

/**
 * The clip of one question, the same for the terminal and for `listen --clip-out`: the question's Moment (moment.ts)
 * as `cutClip` takes it. A word question plays the spot of its own occurrence, a speaker question only the asked
 * voice from the tone on, and a word keeps `padSec` of audio around it.
 */
export function questionClip(options: {
    record: MeetingRecord;
    question: QuestionItem;
    transcript: readonly TranscriptEntry[] | TranscriptLines;
    listen: ListenSettings;
    padSec: number;
}): ClipPlan {
    const { question, ...input } = options;
    return clipPlan(itemMoment({ ...input, item: question }));
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
    toneAtSec?: number;
}

/**
 * `listen --clip-out <dir>`: each question's clip as `<dir>/<Q12>.wav`, cut as the terminal would play it. Nothing plays,
 * no round starts and the record is not changed, so an agent or a test can check a clip without sound (MC22).
 */
export async function writeQuestionClips(options: {
    record: MeetingRecord;
    questions: QuestionItem[];
    transcript: readonly TranscriptEntry[] | TranscriptLines;
    listen: ListenSettings;
    padSec: number;
    audioPath: string;
    dir: string;
    cut?: typeof cutClip;
}): Promise<WrittenClip[]> {
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
            ...(plan.toneAtSec === undefined ? {} : { toneAtSec: plan.toneAtSec }),
        });
    }

    return written;
}

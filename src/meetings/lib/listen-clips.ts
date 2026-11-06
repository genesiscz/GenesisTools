import { join } from "node:path";
import type { MeetingsConfig } from "@genesiscz/utils/meetings/config";
import type { MeetingRecord } from "@genesiscz/utils/meetings/record";
import type { TranscriptLines } from "@genesiscz/utils/transcribe/lines";
import type { TranscriptEntry } from "@genesiscz/utils/transcribe/types";
import { cutClip } from "./audio";
import { askedSpotSec, heardClip, type QuestionItem, questionLabel, questionOccurrence } from "./questions";

export type ListenSettings = MeetingsConfig["global"]["playback"]["listen"];

/** Audio after a speaker question's span, and before it besides the tone's lead. */
export const SPEAKER_PAD_SEC = 0.3;

/** The audio a question plays: the heard stretch, the audio around it, and where the tone sounds. */
export interface ClipPlan {
    fromSec: number;
    toSec: number;
    padSec: number;
    toneAtSec?: number;
}

/**
 * The clip of one question, the same for the terminal and for `listen --clip-out`. A word question plays the spot of its
 * own occurrence, so a word late in a long line is in the clip; a speaker question plays only the asked voice, from the
 * tone on, and a word keeps `padSec` of audio around it.
 */
export function questionClip(options: {
    record: MeetingRecord;
    question: QuestionItem;
    transcript: readonly TranscriptEntry[] | TranscriptLines;
    listen: ListenSettings;
    padSec: number;
}): ClipPlan {
    const { record, question, transcript, listen } = options;
    const occurrence = questionOccurrence(record, question);
    const heard = (question.about === "speaker" ? undefined : heardClip(question, transcript, occurrence)) ??
        question.clip ?? { fromSec: question.fromSec, toSec: question.toSec };
    const spotSec = askedSpotSec(question, transcript, occurrence);
    const pad = question.about === "speaker" ? listen.beepLeadSec + SPEAKER_PAD_SEC : options.padSec;
    const inClip = spotSec >= heard.fromSec - pad && spotSec <= heard.toSec + pad;
    return {
        fromSec: heard.fromSec,
        toSec: heard.toSec,
        padSec: pad,
        ...(listen.beep ? { toneAtSec: (inClip ? spotSec : heard.fromSec) - listen.beepLeadSec } : {}),
    };
}

export interface WrittenClip extends ClipPlan {
    /** The question's number as `listen` and `items` show it (Q12). */
    question: string;
    id: string;
    clip: string;
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
        written.push({ question: label, id: question.id, clip, ...plan });
    }

    return written;
}

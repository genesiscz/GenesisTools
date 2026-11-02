import { join } from "node:path";
import { isInteractive, suggestCommand } from "@genesiscz/utils/cli";
import { ui } from "@genesiscz/utils/cli/ui";
import { logger } from "@genesiscz/utils/logger";
import { LISTEN_PLAYERS, MeetingsConfigStore, resolveDictionary } from "@genesiscz/utils/meetings/config";
import { appendCorrections } from "@genesiscz/utils/meetings/corrections";
import { type MeetingRecord, MeetingStore } from "@genesiscz/utils/meetings/record";
import * as p from "@genesiscz/utils/prompts/p";
import { formatClock } from "@genesiscz/utils/transcribe/render";
import type { Command } from "commander";
import { clipPlayer, cutClip, meetingAudioPath, playClip } from "../lib/audio";
import {
    answerQuestion,
    answerVocabulary,
    NONE_OF_THESE,
    openQuestions,
    type QuestionItem,
    skipQuestion,
} from "../lib/questions";
import { errorText, fail, TOOL } from "../lib/shared";

const { log } = logger.scoped("meetings-listen");

const PAD_CHOICES = [5, 10] as const;
const AGAIN = "\u0000again";
const OTHER = "\u0000other";
const SKIP = "\u0000skip";
const STOP = "\u0000stop";
const TYPE_IT = "\u0000type";

/** Writes one answer (or a skip) and the term corrections it confirms. */
async function record(
    store: MeetingStore,
    meetingId: string,
    question: QuestionItem,
    outcome: { answer: string; comment?: string } | "skip"
): Promise<void> {
    const now = new Date().toISOString();
    const change = outcome === "skip" ? `${question.id} skipped` : `${question.id} → ${outcome.answer}`;
    let ledger: ReturnType<typeof answerQuestion> = [];
    await store.update(meetingId, { command: "listen", change }, (current) => {
        if (outcome === "skip") {
            skipQuestion(current, question.id, now);
            return;
        }

        ledger = answerQuestion(current, question.id, { ...outcome, now });
    });
    appendCorrections(ledger);
}

/** The first `listen` asks how much audio to hear around a range and keeps the answer. */
async function padSeconds(config: MeetingsConfigStore): Promise<number | undefined> {
    const saved = (await config.read()).global.playback.listen.padSec;

    if (saved !== undefined) {
        return saved;
    }

    const picked = await p.select({
        message: "How much audio around each question? (saved as playback.listen.padSec)",
        options: PAD_CHOICES.map((sec) => ({ value: sec, label: `${sec} seconds` })),
    });

    if (p.isCancel(picked)) {
        return undefined;
    }

    await config.setListenPad(Number(picked));
    return Number(picked);
}

/** "Something else": pick a known name or word, or type a new one. */
async function somethingElse(vocabulary: string[]): Promise<string | undefined> {
    const picked = await p.search<string>({
        message: "Who or what is it? (type to filter)",
        options: async () => [
            { value: TYPE_IT, label: "Type it…" },
            ...vocabulary.map((value) => ({ value, label: value })),
        ],
    });

    if (p.isCancel(picked)) {
        return undefined;
    }

    if (picked !== TYPE_IT) {
        return picked;
    }

    const typed = await p.text({ message: "Answer", validate: (value) => (value.trim() ? undefined : "Empty") });
    return p.isCancel(typed) ? undefined : typed.trim();
}

/** Plays one question's clip and asks until it is answered, skipped or the listener stops. */
async function ask(options: {
    question: QuestionItem;
    clip: string;
    player: (typeof LISTEN_PLAYERS)[number];
    vocabulary: string[];
}): Promise<{ answer: string; comment?: string } | "skip" | "stop"> {
    const { question } = options;
    let playing = playClip(options.player, options.clip);

    try {
        while (true) {
            const picked = await p.select({
                message: question.question,
                options: [
                    ...question.choices.map((choice) => ({ value: choice, label: choice })),
                    { value: AGAIN, label: "Play again" },
                    { value: OTHER, label: "Something else…" },
                    { value: NONE_OF_THESE, label: "None of these", hint: "rejects the items it decides" },
                    { value: SKIP, label: "Skip" },
                    { value: STOP, label: "Stop" },
                ],
            });
            playing.kill();

            if (p.isCancel(picked) || picked === STOP) {
                return "stop";
            }

            if (picked === SKIP) {
                return "skip";
            }

            if (picked === AGAIN) {
                playing = playClip(options.player, options.clip);
                continue;
            }

            const answer = picked === OTHER ? await somethingElse(options.vocabulary) : String(picked);

            if (!answer) {
                continue;
            }

            const comment = await p.text({ message: "Comment (optional)", placeholder: "Enter to skip" });
            return { answer, ...(p.isCancel(comment) || !comment.trim() ? {} : { comment: comment.trim() }) };
        }
    } finally {
        playing.kill();
    }
}

async function listen(ref: string, opts: { item?: string; answer?: string; comment?: string }): Promise<void> {
    const store = new MeetingStore();
    let meeting: MeetingRecord | undefined;

    try {
        meeting = store.resolve(ref);
    } catch (err) {
        fail(errorText(err));
        return;
    }

    if (!meeting) {
        fail(`No meeting "${ref}". List them: ${TOOL} list`);
        return;
    }

    const questions = openQuestions(meeting).filter((item) => !opts.item || item.id === opts.item);

    if (questions.length === 0) {
        ui.info(
            opts.item
                ? `${opts.item} is not an open question in ${meeting.id} (${TOOL} items ${meeting.id} --kind question)`
                : `No open questions in ${meeting.id}. Suggest some: ${TOOL} suggest ${meeting.id}`
        );
        return;
    }

    try {
        // An answer given on the command line (an agent relaying the user, or a script): no audio, no prompts.
        if (opts.answer !== undefined) {
            if (!opts.item) {
                fail(`--answer needs --item <id>: it answers one question.`);
                return;
            }

            await record(store, meeting.id, questions[0]!, { answer: opts.answer, comment: opts.comment });
            ui.ok(`${opts.item} answered: ${opts.answer}`);
            return;
        }

        if (!isInteractive()) {
            fail(`listen plays audio and asks in a terminal. Without one, answer a question directly:`);
            ui.raw(
                suggestCommand(TOOL, {
                    replaceCommand: ["listen", meeting.id, "--item", questions[0]!.id, "--answer", "<answer>"],
                })
            );
            return;
        }

        const config = new MeetingsConfigStore();
        const padSec = await padSeconds(config);

        if (padSec === undefined) {
            return;
        }

        const settings = await config.read();
        const player = clipPlayer(settings.global.playback.listen.player, LISTEN_PLAYERS);

        if (!player) {
            fail(`No player found (${LISTEN_PLAYERS.join(", ")}).`);
            return;
        }

        const audioPath = await meetingAudioPath(meeting);
        const dictionary = resolveDictionary(settings, { project: meeting.project, meeting: meeting.dictionary });
        const vocabulary = answerVocabulary(
            meeting,
            dictionary.entries.map((entry) => entry.value)
        );

        for (const [index, question] of questions.entries()) {
            const clip = join(store.folder(meeting.id), "listen", `${question.id}.wav`);
            ui.header(
                `${index + 1}/${questions.length}  ${question.id}  ${formatClock(question.fromSec)}–${formatClock(question.toSec)} (±${padSec} s)`
            );
            await cutClip({ audioPath, fromSec: question.fromSec, toSec: question.toSec, padSec, outPath: clip });
            const outcome = await ask({ question, clip, player, vocabulary });

            if (outcome === "stop") {
                ui.info(`Stopped; ${questions.length - index} questions stay open.`);
                return;
            }

            await record(store, meeting.id, question, outcome);
            log.info({ meeting: meeting.id, question: question.id, outcome }, "question decided");
            ui.ok(outcome === "skip" ? `${question.id} skipped` : `${question.id}: ${outcome.answer}`);
        }

        ui.ok(`All ${questions.length} questions decided. ${TOOL} transcript ${meeting.id}`);
    } catch (err) {
        fail(errorText(err));
    }
}

export function registerListenCommand(program: Command): void {
    program
        .command("listen")
        .argument("<meeting>", "meeting id, a unique prefix, last, or wisprflow:<id>")
        .description("Answer the open questions by ear: each range is cut, played, and its answer decides its items")
        .option("--item <id>", "only this question")
        .option("--answer <text>", `answer --item without listening ("${NONE_OF_THESE}" rejects what it decides)`)
        .option("--comment <text>", "with --answer: a note kept on the question")
        .action(listen);
}

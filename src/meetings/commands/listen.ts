import { join } from "node:path";
import * as clack from "@clack/prompts";
import { isInteractive, suggestCommand } from "@genesiscz/utils/cli";
import { ui } from "@genesiscz/utils/cli/ui";
import { logger } from "@genesiscz/utils/logger";
import { LISTEN_PLAYERS, MeetingsConfigStore, resolveDictionary } from "@genesiscz/utils/meetings/config";
import { appendCorrections, type Correction } from "@genesiscz/utils/meetings/corrections";
import { type MeetingItem, type MeetingRecord, MeetingStore } from "@genesiscz/utils/meetings/record";
import { searchSelect } from "@genesiscz/utils/prompts/clack/search-select";
import { formatClock } from "@genesiscz/utils/transcribe/render";
import type { TranscriptEntry } from "@genesiscz/utils/transcribe/types";
import type { Command } from "commander";
import pc from "picocolors";
import {
    ANSWER_LOG_FILE,
    type AnswerEvent,
    appendAnswerEvent,
    type RoundEndReason,
    readAnswerEvents,
    runningRound,
    subscribeAnswers,
} from "../lib/answer-log";
import { clipPlayer, cutClip, meetingAudioPath, playClip } from "../lib/audio";
import { energyMicShareFor } from "../lib/energy";
import { speakingEvidence } from "../lib/platforms";
import {
    answerQuestion,
    answerVocabulary,
    askedSpotSec,
    type HeardContext,
    heardContext,
    NONE_OF_THESE,
    openQuestions,
    propagateAnswer,
    type QuestionItem,
    questionNumber,
    skipQuestion,
    splitQuestion,
} from "../lib/questions";
import { errorText, fail, TOOL } from "../lib/shared";
import { linkedSource, meetingTranscript } from "../lib/sources";

const { log } = logger.scoped("meetings-listen");

const PAD_CHOICES = [5, 10] as const;
const AGAIN = "\u0000again";
const OTHER = "\u0000other";
const SKIP = "\u0000skip";
const STOP = "\u0000stop";
const TYPE_IT = "\u0000type";
const SPLIT = "\u0000split";
const DEFAULT_SUBSCRIBE_MINUTES = 120;
/** Audio after a speaker question's span, and before it besides the tone's lead. */
const SPEAKER_PAD_SEC = 0.3;
const SAID_MAX_CHARS = 240;

type Outcome = { answer: string; comment?: string } | "skip" | "split" | "stop" | "back";

/** One decided question of the round: the items before the decision, so Esc can undo it. */
interface Step {
    question: QuestionItem;
    before: MeetingItem[];
    /** The answer given, for a later question on the same heard words. */
    answer?: string;
    /** A split: its parts take its place, so it does not count against the budget. */
    split?: true;
    /** Written when the round ends, so an undone answer leaves no correction behind. */
    corrections: Correction[];
}

/** Writes one answer or skip; returns the questions the answer settled and the corrections it confirms. */
async function decide(options: {
    store: MeetingStore;
    meetingId: string;
    question: QuestionItem;
    outcome: { answer: string; comment?: string } | "skip";
    listenBelow: number;
}): Promise<{ settled: string[]; corrections: Correction[] }> {
    const { question, outcome } = options;
    const now = new Date().toISOString();
    const change = outcome === "skip" ? `${question.id} skipped` : `${question.id} → ${outcome.answer}`;
    let corrections: Correction[] = [];
    let settled: string[] = [];
    await options.store.update(options.meetingId, { command: "listen", change }, (current) => {
        if (outcome === "skip") {
            skipQuestion(current, question.id, now);
            return;
        }

        corrections = answerQuestion(current, question.id, { ...outcome, now });
        settled = propagateAnswer(current, question, { answer: outcome.answer, listenBelow: options.listenBelow, now });
    });
    return { settled, corrections };
}

function answeredEvent(question: QuestionItem, answer: { answer: string; comment?: string }, settled: string[]) {
    const event: AnswerEvent = {
        event: "answered",
        at: new Date().toISOString(),
        item: question.id,
        about: question.about,
        fromSec: question.fromSec,
        toSec: question.toSec,
        question: question.question,
        ...(question.heard ? { heard: question.heard } : {}),
        answer: answer.answer,
        ...(answer.comment ? { comment: answer.comment } : {}),
        settled,
    };
    return event;
}

/** The first `listen` asks how much audio to hear around a range and keeps the answer. */
async function padSeconds(config: MeetingsConfigStore): Promise<number | undefined> {
    const saved = (await config.read()).global.playback.listen.padSec;

    if (saved !== undefined) {
        return saved;
    }

    const picked = await clack.select({
        message: "How much audio around each question? (saved as playback.listen.padSec)",
        options: PAD_CHOICES.map((sec) => ({ value: sec, label: `${sec} seconds` })),
    });

    if (clack.isCancel(picked)) {
        return undefined;
    }

    await config.setListenPad(Number(picked));
    return Number(picked);
}

/** "Something else": pick a known name or word, or type a new one. Esc returns undefined (back to the choices). */
async function somethingElse(vocabulary: string[]): Promise<string | undefined> {
    const picked = await searchSelect<string>({
        message: "Who or what is it? (type to filter, Esc goes back)",
        items: [{ value: TYPE_IT, label: "Type it…" }, ...vocabulary.map((value) => ({ value, label: value }))],
    });

    if (typeof picked === "symbol") {
        return undefined;
    }

    if (picked !== TYPE_IT) {
        return picked;
    }

    const typed = await clack.text({ message: "Answer", validate: (value) => (value?.trim() ? undefined : "Empty") });
    return clack.isCancel(typed) ? undefined : typed.trim();
}

type MicShare = (fromSec: number, toSec: number) => number | undefined;

/** The microphone's energy share over time, when the source keeps the audio and its channels are calibrated. */
async function micShareOf(store: MeetingStore, meeting: MeetingRecord): Promise<MicShare | undefined> {
    const { source, sourceMeetingId } = await linkedSource(meeting);
    const evidence = speakingEvidence(meeting, await source.evidence(sourceMeetingId));
    return (await energyMicShareFor(store, meeting, evidence)).share;
}

/** The words of the lines a speaker question asks about; a split part names its own words in the question. */
function spokenIn(question: QuestionItem, transcript: TranscriptEntry[]): string | undefined {
    if (question.question.startsWith('Who says "')) {
        return undefined;
    }

    const text = transcript
        .filter(
            (entry) =>
                entry.startSec !== undefined &&
                entry.startSec >= question.fromSec - 0.5 &&
                (entry.startSec < question.toSec || entry.startSec === question.fromSec)
        )
        .map((entry) => entry.text)
        .join(" ");
    return text.length > SAID_MAX_CHARS ? `${text.slice(0, SAID_MAX_CHARS)}…` : text || undefined;
}

/** The words around a word question's heard words: the line before (dim), the line with them marked, the line after. */
function contextLines(context: HeardContext): string {
    const lines = [
        context.before ? pc.dim(context.before) : undefined,
        `${pc.cyan(context.lead)}${pc.bold(pc.yellow(context.heard))}${pc.cyan(context.rest)}`,
        context.after ? pc.dim(context.after) : undefined,
    ];
    return lines
        .filter((line) => line !== undefined)
        .map((line) => `\n  ${line}`)
        .join("");
}

/**
 * Shows one question, plays its clip after `delayMs` (again and again with `repeatGapMs`, until it is answered), and
 * asks until it is answered, skipped, split or left. Esc on the choices goes back to the previous question; Esc in a
 * later step goes back to the choices.
 */
async function ask(options: {
    question: QuestionItem;
    clip: string;
    player: (typeof LISTEN_PLAYERS)[number];
    vocabulary: string[];
    delayMs: number;
    repeatGapMs?: number;
    /** What is said in the asked span, shown under the question. */
    said?: string;
    /** For a word question: the sentence its heard words are in. */
    context?: HeardContext;
    /** The answer this round gave the same heard words at another time: offered first. */
    earlier?: { answer: string; atSec: number };
}): Promise<Outcome> {
    const { question, earlier } = options;
    const repeat = options.repeatGapMs === undefined ? {} : { repeatGapMs: options.repeatGapMs };
    let playing = playClip(options.player, options.clip, { delayMs: options.delayMs, ...repeat });
    const shown = options.context
        ? contextLines(options.context)
        : options.said
          ? `\n  ${pc.cyan(`„${options.said}“`)}`
          : "";
    const earlierNote = earlier
        ? `\n  ${pc.dim(`You answered the same words at ${formatClock(earlier.atSec)}: ${earlier.answer}`)}`
        : "";
    const choices = earlier
        ? [earlier.answer, ...question.choices.filter((choice) => choice !== earlier.answer)]
        : question.choices;

    try {
        while (true) {
            const picked = await clack.select({
                message: `${question.question} ${pc.dim("(Esc: back to the previous question)")}${shown}${earlierNote}`,
                options: [
                    ...choices.map((choice) => ({
                        value: choice,
                        label: choice,
                        ...(earlier && choice === earlier.answer
                            ? { hint: `as at ${formatClock(earlier.atSec)}` }
                            : {}),
                    })),
                    { value: AGAIN, label: "Play the audio again", hint: "from the start" },
                    { value: OTHER, label: "Something else…" },
                    { value: NONE_OF_THESE, label: "None of these", hint: "rejects the items it decides" },
                    ...(question.about === "speaker"
                        ? [
                              {
                                  value: SPLIT,
                                  label: "Several voices",
                                  hint: "cut at each line and each change between your microphone and the call, then ask each part",
                              },
                          ]
                        : []),
                    { value: SKIP, label: "Skip" },
                    { value: STOP, label: "Enough for now", hint: "the rest stay open for the next listen" },
                ],
            });

            if (clack.isCancel(picked)) {
                return "back";
            }

            if (picked === STOP || picked === SKIP || picked === SPLIT) {
                return picked === STOP ? "stop" : picked === SKIP ? "skip" : "split";
            }

            if (picked === AGAIN) {
                playing.stop();
                playing = playClip(options.player, options.clip, repeat);
                continue;
            }

            // The clip keeps playing while the answer is typed.
            const answer = picked === OTHER ? await somethingElse(options.vocabulary) : String(picked);

            if (!answer) {
                continue;
            }

            playing.stop();
            const comment = await clack.text({
                message: `Comment (optional) ${pc.dim("(Esc: back to the choices)")}`,
                placeholder: "Enter to skip",
            });

            if (clack.isCancel(comment)) {
                playing = playClip(options.player, options.clip, repeat);
                continue;
            }

            return { answer, ...(comment?.trim() ? { comment: comment.trim() } : {}) };
        }
    } finally {
        playing.stop();
    }
}

async function subscribe(meeting: MeetingRecord, store: MeetingStore, opts: ListenOptions): Promise<void> {
    const path = join(store.folder(meeting.id), ANSWER_LOG_FILE);
    const roundRunning = runningRound(readAnswerEvents(path)).length > 0;

    if (!roundRunning && !opts.fromStart && openQuestions(meeting).length === 0) {
        process.stderr.write(`No open questions in ${meeting.id} and no listen round running.\n`);
        return;
    }

    const minutes = opts.timeout === undefined ? DEFAULT_SUBSCRIBE_MINUTES : Number(opts.timeout);

    if (!Number.isFinite(minutes) || minutes <= 0) {
        fail(`--timeout takes minutes, more than 0 (got "${opts.timeout}").`);
        return;
    }

    process.exitCode = await subscribeAnswers({
        path,
        fromStart: opts.fromStart === true,
        timeoutMs: minutes * 60_000,
        write: (line) => process.stdout.write(`${line}\n`),
    });
}

interface ListenOptions {
    item?: string;
    answer?: string;
    comment?: string;
    subscribeAnswers?: boolean;
    fromStart?: boolean;
    timeout?: string;
}

async function listen(ref: string, opts: ListenOptions): Promise<void> {
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

    if (opts.subscribeAnswers) {
        await subscribe(meeting, store, opts);
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

    const logPath = join(store.folder(meeting.id), ANSWER_LOG_FILE);

    try {
        // An answer given on the command line (an agent relaying the user, or a script): no audio, no prompts.
        if (opts.answer !== undefined) {
            if (!opts.item) {
                fail(`--answer needs --item <id>: it answers one question.`);
                return;
            }

            const settings = await new MeetingsConfigStore().read();
            const answer = { answer: opts.answer, ...(opts.comment ? { comment: opts.comment } : {}) };
            const { settled, corrections } = await decide({
                store,
                meetingId: meeting.id,
                question: questions[0]!,
                outcome: answer,
                listenBelow: settings.global.suggest.listenBelow,
            });
            appendCorrections(corrections);
            appendAnswerEvent(logPath, answeredEvent(questions[0]!, answer, settled));

            if (settled.length > 0) {
                ui.dim(`the same answer settled ${settled.length} more: ${settled.join(" ")}`);
            }

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
        const { budget, minPriority, delaySec, beep, beepLeadSec, repeat, repeatGapSec } =
            settings.global.playback.listen;
        const transcript: TranscriptEntry[] = await meetingTranscript(meeting);
        await round({
            meeting,
            store,
            logPath,
            only: opts.item,
            budget,
            minPriority,
            listenBelow: settings.global.suggest.listenBelow,
            ask: async (question, earlier) => {
                const clip = join(store.folder(meeting.id), "listen", `${question.id}.wav`);
                const heard = question.clip ?? { fromSec: question.fromSec, toSec: question.toSec };
                const spotSec = askedSpotSec(question, transcript);
                const context =
                    question.about === "speaker" ? undefined : heardContext(question, transcript, SAID_MAX_CHARS);
                // A speaker question plays only the asked voice, from the tone on; a word keeps the audio around it.
                const pad = question.about === "speaker" ? beepLeadSec + SPEAKER_PAD_SEC : padSec;
                const inClip = spotSec >= heard.fromSec - pad && spotSec <= heard.toSec + pad;
                await cutClip({
                    audioPath,
                    fromSec: heard.fromSec,
                    toSec: heard.toSec,
                    padSec: pad,
                    outPath: clip,
                    ...(beep ? { toneAtSec: (inClip ? spotSec : heard.fromSec) - beepLeadSec } : {}),
                });
                return await ask({
                    question,
                    clip,
                    player,
                    vocabulary,
                    delayMs: delaySec * 1000,
                    ...(repeat ? { repeatGapMs: repeatGapSec * 1000 } : {}),
                    ...(question.about === "speaker" ? { said: spokenIn(question, transcript) } : {}),
                    ...(context ? { context } : {}),
                    ...(earlier ? { earlier } : {}),
                });
            },
        });
    } catch (err) {
        fail(errorText(err));
    }
}

/** One listening round: asks question after question, keeps each decision on a stack so Esc can undo it. */
async function round(options: {
    meeting: MeetingRecord;
    store: MeetingStore;
    logPath: string;
    only?: string;
    budget: number;
    minPriority: number;
    listenBelow: number;
    ask: (question: QuestionItem, earlier?: { answer: string; atSec: number }) => Promise<Outcome>;
}): Promise<void> {
    const { meeting, store, logPath, only, minPriority } = options;
    const askable = (record: MeetingRecord, passed: Set<string>, reask?: string) =>
        openQuestions(record).find(
            (item) =>
                (reask ? item.id === reask : !passed.has(item.id)) &&
                (reask !== undefined || !only || item.id === only || passed.size > 0) &&
                (reask !== undefined || only !== undefined || (item.priority ?? minPriority) >= minPriority)
        );
    const steps: Step[] = [];
    const passed = new Set<string>();
    const total = Math.min(
        options.budget,
        openQuestions(meeting).filter((item) =>
            only ? item.id === only : (item.priority ?? minPriority) >= minPriority
        ).length || 1
    );
    let ended = false;
    let reask: string | undefined;
    let micShares: Promise<MicShare | undefined> | undefined;
    let reason: RoundEndReason = "done";
    const decided = (): number => steps.filter((step) => !step.split).length;
    const earlierFor = (question: QuestionItem): { answer: string; atSec: number } | undefined => {
        const heard = question.heard?.toLowerCase();
        const step = heard
            ? steps.findLast((done) => done.answer !== undefined && done.question.heard?.toLowerCase() === heard)
            : undefined;
        return step?.answer === undefined ? undefined : { answer: step.answer, atSec: step.question.fromSec };
    };

    const end = (why: RoundEndReason): void => {
        if (ended) {
            return;
        }

        ended = true;
        appendCorrections(steps.flatMap((step) => step.corrections));
        const open = openQuestions(store.read(meeting.id) ?? meeting).length;
        appendAnswerEvent(logPath, {
            event: "round-end",
            at: new Date().toISOString(),
            reason: why,
            asked: decided(),
            open,
        });
        ui.ok(`${decided()} decided; ${open} open questions stay, marked in ${TOOL} transcript ${meeting.id}.`);

        if (why === "budget" && open > 0) {
            ui.info(
                `This round asks at most ${options.budget} questions. The next round asks the rest: ${TOOL} listen ${meeting.id}`
            );
        }
    };
    // Ctrl-C outside a prompt (while a clip is cut) ends the process; the exit handler still closes the round.
    const onExit = (): void => end("aborted");
    const onSigint = (): void => process.exit(130);
    process.once("exit", onExit);
    process.once("SIGINT", onSigint);
    appendAnswerEvent(logPath, { event: "round-start", at: new Date().toISOString(), pid: process.pid, open: total });

    try {
        while (decided() < options.budget) {
            const current = store.read(meeting.id) ?? meeting;
            const question = askable(current, passed, reask);
            reask = undefined;

            if (!question) {
                break;
            }

            ui.header(
                `${decided() + 1}/${total}  Q${questionNumber(current, question.id)} (${question.id})  ${formatClock(question.fromSec)}–${formatClock(question.toSec)}${question.priority === undefined ? "" : `  priority ${question.priority}`}`
            );
            const outcome = await options.ask(question, earlierFor(question));

            if (outcome === "stop") {
                reason = "stopped";
                break;
            }

            if (outcome === "back") {
                const last = steps.pop();

                if (!last) {
                    const leave = await clack.select({
                        message: "Leave this round? The answers are saved; the next listen goes on from here.",
                        options: [
                            { value: "stay", label: "Stay on this question" },
                            { value: "leave", label: "Leave" },
                        ],
                    });

                    if (clack.isCancel(leave) || leave === "leave") {
                        reason = "stopped";
                        break;
                    }

                    reask = question.id;
                    continue;
                }

                await store.update(
                    meeting.id,
                    { command: "listen", change: `${last.question.id} reopened` },
                    (next) => {
                        next.items = last.before;
                    }
                );
                passed.delete(last.question.id);
                appendAnswerEvent(logPath, { event: "reopened", at: new Date().toISOString(), item: last.question.id });
                ui.dim(`  back to ${last.question.id}: its answer is undone`);
                reask = last.question.id;
                continue;
            }

            const before = structuredClone(current.items);

            if (outcome === "split") {
                const transcript = await meetingTranscript(current);
                micShares ??= micShareOf(store, current);
                const micShare = await micShares;
                let parts = 0;
                await store.update(
                    meeting.id,
                    { command: "listen", change: `${question.id} split per line and voice` },
                    (next) => {
                        parts = splitQuestion(next, question.id, {
                            transcript,
                            now: new Date().toISOString(),
                            ...(micShare ? { micShare } : {}),
                        }).length;
                    }
                );

                if (parts === 0) {
                    ui.warn(
                        `${question.id}: no second line and no change between your microphone and the call to cut at, so it stays open. Answer it with "Something else…", for example "Novák, then Dvořák".`
                    );
                    reask = question.id;
                    continue;
                }

                steps.push({ question, before, corrections: [], split: true });
                appendAnswerEvent(logPath, {
                    event: "split",
                    at: new Date().toISOString(),
                    item: question.id,
                    into: parts,
                });
                ui.info(`${question.id}: split into ${parts} parts, one per line and voice; they come next.`);
                continue;
            }

            passed.add(question.id);
            const { settled, corrections } = await decide({
                store,
                meetingId: meeting.id,
                question,
                outcome,
                listenBelow: options.listenBelow,
            });
            steps.push({ question, before, corrections, ...(outcome === "skip" ? {} : { answer: outcome.answer }) });
            appendAnswerEvent(
                logPath,
                outcome === "skip"
                    ? { event: "skipped", at: new Date().toISOString(), item: question.id }
                    : answeredEvent(question, outcome, settled)
            );
            log.info({ meeting: meeting.id, question: question.id, outcome, settled }, "question decided");
            ui.ok(outcome === "skip" ? `${question.id} skipped` : `${question.id}: ${outcome.answer}`);

            if (settled.length > 0) {
                ui.dim(`  the same answer settled ${settled.length} more: ${settled.join(" ")}`);
            }
        }

        if (reason === "done" && decided() >= options.budget) {
            reason = "budget";
        }
    } finally {
        process.off("exit", onExit);
        process.off("SIGINT", onSigint);
        end(reason);
    }
}

export function registerListenCommand(program: Command): void {
    program
        .command("listen")
        .argument("<meeting>", "meeting id, a unique prefix, last, or wisprflow:<id>")
        .description(
            "Answer the open questions by ear, one at a time: each range is cut, played, and its answer decides its items"
        )
        .option("--item <id>", "only this question")
        .option("--answer <text>", `answer --item without listening ("${NONE_OF_THESE}" rejects what it decides)`)
        .option("--comment <text>", "with --answer: a note kept on the question")
        .option(
            "--subscribe-answers",
            "for an agent: print each answer as one JSON line while the person answers; exit when the round ends"
        )
        .option("--from-start", "with --subscribe-answers: print every earlier round first")
        .option(
            "--timeout <minutes>",
            `with --subscribe-answers: give up after this long (default ${DEFAULT_SUBSCRIBE_MINUTES})`
        )
        .action(listen);
}

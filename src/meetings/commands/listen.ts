import { join } from "node:path";
import * as clack from "@clack/prompts";
import { isInteractive, suggestCommand } from "@genesiscz/utils/cli";
import { ui } from "@genesiscz/utils/cli/ui";
import {
    LISTEN_PLAYERS,
    type MeetingsConfig,
    MeetingsConfigStore,
    resolveDictionary,
} from "@genesiscz/utils/meetings/config";
import { type MeetingRecord, MeetingStore } from "@genesiscz/utils/meetings/record";
import { type ChoiceRow, choiceChip, choiceSelect, heardMark } from "@genesiscz/utils/prompts/clack/choice-select";
import { searchSelect } from "@genesiscz/utils/prompts/clack/search-select";
import { TranscriptLines } from "@genesiscz/utils/transcribe/lines";
import { formatClock } from "@genesiscz/utils/transcribe/render";
import type { Command } from "commander";
import pc from "picocolors";
import { ANSWER_LOG_FILE, readAnswerEvents, runningRound, subscribeAnswers } from "../lib/answer-log";
import { clipPlayer, cutClip, meetingAudioPath, playClip } from "../lib/audio";
import { energyMicShareFor } from "../lib/energy";
import {
    type AskedQuestion,
    type ListenAdapter,
    type ListenOutcome,
    ListenSession,
    type MicShare,
    type SessionNote,
} from "../lib/listen-session";
import { GivenAnswerAdapter } from "../lib/listen-session-answer";
import { speakingEvidence } from "../lib/platforms";
import {
    answerVocabulary,
    askedSpotSec,
    type HeardContext,
    heardClip,
    NONE_OF_THESE,
    openQuestions,
    type QuestionItem,
    questionIdOf,
    questionLabel,
    questionOccurrence,
    questionView,
} from "../lib/questions";
import { errorText, fail, TOOL } from "../lib/shared";
import { linkedSource, meetingTranscript } from "../lib/sources";

const PAD_CHOICES = [5, 10] as const;
const AGAIN = "\u0000again";
const OTHER = "\u0000other";
const SKIP = "\u0000skip";
const STOP = "\u0000stop";
const SPLIT = "\u0000split";
const DEFAULT_SUBSCRIBE_MINUTES = 120;
/** Audio after a speaker question's span, and before it besides the tone's lead. */
const SPEAKER_PAD_SEC = 0.3;
const SAID_MAX_CHARS = 240;

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

/**
 * "Something else": pick a known name or word, or type a new one: the typed text is always the first row, so Enter
 * takes it when nothing matches. Esc returns undefined (back to the choices).
 */
async function somethingElse(vocabulary: string[], context: string[]): Promise<string | undefined> {
    const picked = await searchSelect<string>({
        message: ["Who or what is it?", ...context].join("\n"),
        items: vocabulary.map((value) => ({ value, label: value })),
        typed: {
            label: (query) => (query ? `Use "${query}" as typed` : "Type to filter, or type a new answer"),
            resolve: (query) => query.trim() || undefined,
        },
    });
    return typeof picked === "symbol" ? undefined : picked;
}

/** The microphone's energy share over time, when the source keeps the audio and its channels are calibrated. */
async function micShareOf(store: MeetingStore, meeting: MeetingRecord): Promise<MicShare | undefined> {
    const { source, sourceMeetingId } = await linkedSource(meeting);
    const evidence = speakingEvidence(meeting, await source.evidence(sourceMeetingId));
    return (await energyMicShareFor(store, meeting, evidence)).share;
}

/** The words around a word question's heard words: the line before (dim), the line with them marked, the line after. */
function contextLines(context: HeardContext): string[] {
    return [
        context.before ? pc.dim(context.before) : undefined,
        `${context.lead}${heardMark(context.heard)}${context.rest}`,
        context.after ? pc.dim(context.after) : undefined,
    ].filter((line) => line !== undefined);
}

/** The asked question's rows: its answers first, then the actions, each with its glyph and colour. */
function choiceRows(options: {
    question: QuestionItem;
    choices: string[];
    earlier?: { answer: string; atSec: number };
}): ChoiceRow<string>[] {
    const { question, earlier } = options;
    return [
        ...options.choices.map((choice) => ({
            value: choice,
            label: choice,
            kind: "answer" as const,
            ...(earlier && choice === earlier.answer ? { hint: `as at ${formatClock(earlier.atSec)}` } : {}),
        })),
        {
            value: AGAIN,
            label: "Play the audio again",
            hint: "from the start",
            kind: "action",
            glyph: "↻",
            paint: pc.yellow,
        },
        {
            value: OTHER,
            label: "Something else…",
            hint: "pick a known name or word, or type a new one",
            kind: "action",
            glyph: "✎",
            paint: pc.magenta,
        },
        {
            value: NONE_OF_THESE,
            label: "None of these",
            hint: "rejects the items it decides",
            kind: "action",
            glyph: "⊘",
            paint: pc.red,
        },
        ...(question.about === "speaker"
            ? [
                  {
                      value: SPLIT,
                      label: "Several voices",
                      hint: "cut at each line and each change between your microphone and the call, then ask each part",
                      kind: "action" as const,
                      glyph: "⇆",
                      paint: pc.cyan,
                  },
              ]
            : []),
        { value: SKIP, label: "Skip", hint: "leave it open", kind: "action", glyph: "»", paint: pc.dim },
        {
            value: STOP,
            label: "Enough for now",
            hint: "the rest stay open for the next listen",
            kind: "action",
            glyph: "◼",
            paint: pc.dim,
        },
    ];
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
    /** The styled header line: question number, progress and time range. */
    header?: string;
}): Promise<ListenOutcome> {
    const { question, earlier } = options;
    const repeat = options.repeatGapMs === undefined ? {} : { repeatGapMs: options.repeatGapMs };
    let playing = playClip(options.player, options.clip, { delayMs: options.delayMs, ...repeat });
    const shown = options.context
        ? contextLines(options.context)
        : options.said
          ? [pc.italic(`„${options.said}“`)]
          : [];
    const earlierNote = earlier
        ? `${pc.dim("↺")} ${pc.dim(`you answered these words at ${formatClock(earlier.atSec)}: `)}${pc.cyan(earlier.answer)}`
        : undefined;
    const choices = earlier
        ? [earlier.answer, ...question.choices.filter((choice) => choice !== earlier.answer)]
        : question.choices;

    try {
        while (true) {
            const picked = await choiceSelect<string>({
                message: question.question,
                ...(options.header ? { header: options.header } : {}),
                context: shown,
                ...(earlierNote ? { note: earlierNote } : {}),
                rows: choiceRows({ question, choices, ...(earlier ? { earlier } : {}) }),
                formatSubmitted: (row) => row.label,
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
            const answer = picked === OTHER ? await somethingElse(options.vocabulary, shown) : String(picked);

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

/** The terminal: each question's clip is cut and played, and the person picks an answer in the choice select. */
class TerminalAdapter implements ListenAdapter {
    constructor(
        private readonly deps: {
            store: MeetingStore;
            meeting: MeetingRecord;
            audioPath: string;
            player: (typeof LISTEN_PLAYERS)[number];
            vocabulary: string[];
            transcript: TranscriptLines;
            padSec: number;
            listen: ListenSettings;
        }
    ) {}

    async ask(asked: AskedQuestion): Promise<ListenOutcome> {
        const { store, meeting, transcript, listen } = this.deps;
        const { question } = asked;
        const view = questionView(asked.record, question, transcript, SAID_MAX_CHARS);
        const clip = join(store.folder(meeting.id), "listen", `${question.id}.wav`);
        const occurrence = questionOccurrence(asked.record, question);
        // A word question plays the spot of its own occurrence, so a word late in a long line is in the clip.
        const heard = (question.about === "speaker" ? undefined : heardClip(question, transcript, occurrence)) ??
            question.clip ?? { fromSec: question.fromSec, toSec: question.toSec };
        const spotSec = askedSpotSec(question, transcript, occurrence);
        // A speaker question plays only the asked voice, from the tone on; a word keeps the audio around it.
        const pad = question.about === "speaker" ? listen.beepLeadSec + SPEAKER_PAD_SEC : this.deps.padSec;
        const inClip = spotSec >= heard.fromSec - pad && spotSec <= heard.toSec + pad;
        await cutClip({
            audioPath: this.deps.audioPath,
            fromSec: heard.fromSec,
            toSec: heard.toSec,
            padSec: pad,
            outPath: clip,
            ...(listen.beep ? { toneAtSec: (inClip ? spotSec : heard.fromSec) - listen.beepLeadSec } : {}),
        });
        const part = asked.part ? ` · part ${asked.part.n}/${asked.part.of}` : "";
        const priority = view.priority === undefined ? "" : ` · priority ${view.priority}`;
        return await ask({
            question,
            clip,
            player: this.deps.player,
            vocabulary: this.deps.vocabulary,
            delayMs: listen.delaySec * 1000,
            ...(listen.repeat ? { repeatGapMs: listen.repeatGapSec * 1000 } : {}),
            ...(view.said ? { said: view.said } : {}),
            ...(view.context ? { context: view.context } : {}),
            ...(asked.earlier ? { earlier: asked.earlier } : {}),
            header: `${choiceChip(view.label)} ${pc.dim(`${asked.position}/${asked.total}${part} · ${view.range}${priority}`)}`,
        });
    }

    async confirmLeave(): Promise<boolean> {
        const leave = await clack.select({
            message: "Leave this round? The answers are saved; the next listen goes on from here.",
            options: [
                { value: "stay", label: "Stay on this question" },
                { value: "leave", label: "Leave" },
            ],
        });
        return clack.isCancel(leave) || leave === "leave";
    }

    note(note: SessionNote): void {
        const { meeting } = this.deps;

        if (note.kind === "decided") {
            ui.ok(note.outcome === "skip" ? `${note.label} skipped` : `${note.label}: ${note.outcome.answer}`);

            if (note.settled.length > 0) {
                ui.dim(`  the same answer settled ${note.settled.length} more: ${note.settled.join(" ")}`);
            }

            return;
        }

        if (note.kind === "split") {
            ui.info(`${note.label}: split into ${note.parts} parts, one per line and voice; they come next.`);
            return;
        }

        if (note.kind === "not-split") {
            ui.warn(
                `${note.label}: no second line and no change between your microphone and the call to cut at, so it stays open. Answer it with "Something else…", for example "Novák, then Dvořák".`
            );
            return;
        }

        if (note.kind === "undone") {
            ui.dim(`  back to ${note.label}: its answer is undone`);
            return;
        }

        ui.ok(`${note.decided} decided; ${note.open} open questions stay, marked in ${TOOL} transcript ${meeting.id}.`);

        if (note.reason === "budget" && note.open > 0) {
            ui.info(
                `This round asks at most ${note.budget} questions. The next round asks the rest: ${TOOL} listen ${meeting.id}`
            );
        }
    }
}

type ListenSettings = MeetingsConfig["global"]["playback"]["listen"];

interface AdapterContext {
    store: MeetingStore;
    meeting: MeetingRecord;
    opts: ListenOptions;
    first: QuestionItem;
    settings: MeetingsConfig;
}

/** The adapter the session asks through, the budget it gets, and whether it joins a round already running. */
interface AdapterChoice {
    adapter: ListenAdapter;
    budget: number;
    joinRunningRound?: boolean;
}

const ADAPTERS: Record<"terminal" | "answer", (context: AdapterContext) => Promise<AdapterChoice | undefined>> = {
    answer: async ({ opts }) => {
        if (!opts.item || opts.answer === undefined) {
            fail(`--answer needs --item <Q12>: it answers one question.`);
            return undefined;
        }

        const answer = { answer: opts.answer, ...(opts.comment ? { comment: opts.comment } : {}) };
        const adapter = new GivenAnswerAdapter(answer, (line, tone) => (tone === "ok" ? ui.ok(line) : ui.dim(line)));
        return { adapter, budget: 1, joinRunningRound: true };
    },
    terminal: async ({ store, meeting, first, settings }) => {
        if (!isInteractive()) {
            fail(`listen plays audio and asks in a terminal. Without one, answer a question directly:`);
            ui.raw(
                suggestCommand(TOOL, {
                    replaceCommand: [
                        "listen",
                        meeting.id,
                        "--item",
                        questionLabel(meeting, first.id),
                        "--answer",
                        "<answer>",
                    ],
                })
            );
            return undefined;
        }

        const padSec = await padSeconds(new MeetingsConfigStore());

        if (padSec === undefined) {
            return undefined;
        }

        const listen = settings.global.playback.listen;
        const player = clipPlayer(listen.player, LISTEN_PLAYERS);

        if (!player) {
            fail(`No player found (${LISTEN_PLAYERS.join(", ")}).`);
            return undefined;
        }

        const dictionary = resolveDictionary(settings, { project: meeting.project, meeting: meeting.dictionary });
        const adapter = new TerminalAdapter({
            store,
            meeting,
            audioPath: await meetingAudioPath(meeting),
            player,
            vocabulary: answerVocabulary(
                meeting,
                dictionary.entries.map((entry) => entry.value)
            ),
            transcript: new TranscriptLines(await meetingTranscript(meeting)),
            padSec,
            listen,
        });
        return { adapter, budget: listen.budget };
    },
};

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

    const itemId = opts.item ? questionIdOf(meeting, opts.item) : undefined;
    const first = openQuestions(meeting).find((item) => !itemId || item.id === itemId);

    if (!first) {
        ui.info(
            opts.item
                ? `${opts.item} is not an open question in ${meeting.id} (${TOOL} items ${meeting.id} --kind question)`
                : `No open questions in ${meeting.id}. Suggest some: ${TOOL} suggest ${meeting.id}`
        );
        return;
    }

    try {
        const settings = await new MeetingsConfigStore().read();
        const chosen = await ADAPTERS[opts.answer === undefined ? "terminal" : "answer"]({
            store,
            meeting,
            opts,
            first,
            settings,
        });

        if (!chosen) {
            return;
        }

        const session = new ListenSession({
            store,
            meeting,
            logPath: join(store.folder(meeting.id), ANSWER_LOG_FILE),
            adapter: chosen.adapter,
            ...(itemId ? { only: itemId } : {}),
            budget: chosen.budget,
            minPriority: settings.global.playback.listen.minPriority,
            listenBelow: settings.global.suggest.listenBelow,
            ...(chosen.joinRunningRound ? { joinRunningRound: true } : {}),
            split: {
                transcript: (current) => meetingTranscript(current),
                micShare: (current) => micShareOf(store, current),
            },
        });
        // Ctrl-C outside a prompt (while a clip is cut) ends the process; the exit handler still closes the round.
        const onExit = (): void => session.end("aborted");
        const onSigint = (): void => process.exit(130);
        process.once("exit", onExit);
        process.once("SIGINT", onSigint);

        try {
            await session.run();
        } finally {
            process.off("exit", onExit);
            process.off("SIGINT", onSigint);
        }
    } catch (err) {
        fail(errorText(err));
    }
}

export function registerListenCommand(program: Command): void {
    program
        .command("listen")
        .argument("<meeting>", "meeting id, a unique prefix, last, or wisprflow:<id>")
        .description(
            "Answer the open questions by ear, one at a time: each range is cut, played, and its answer decides its items"
        )
        .option("--item <Q12|id>", "only this question: its number as listen shows it (Q12), or its item id")
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

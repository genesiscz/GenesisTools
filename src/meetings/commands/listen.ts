import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import * as clack from "@clack/prompts";
import { isInteractive, suggestCommand } from "@genesiscz/utils/cli";
import { ui } from "@genesiscz/utils/cli/ui";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import {
    LISTEN_PLAYERS,
    type ListenPads,
    listenPads,
    type MeetingsConfig,
    MeetingsConfigStore,
    resolveDictionary,
} from "@genesiscz/utils/meetings/config";
import { meetingPeopleNames } from "@genesiscz/utils/meetings/people-directory";
import { type DecisionActor, type MeetingRecord, MeetingStore } from "@genesiscz/utils/meetings/record";
import { type ChoiceRow, choiceChip, choiceSelect, heardMark } from "@genesiscz/utils/prompts/clack/choice-select";
import { searchSelect } from "@genesiscz/utils/prompts/clack/search-select";
import { TranscriptLines } from "@genesiscz/utils/transcribe/lines";
import { formatClock } from "@genesiscz/utils/transcribe/render";
import type { Command } from "commander";
import pc from "picocolors";
import { prepareFindings } from "../lib/add-findings";
import { ANSWER_LOG_FILE, readAnswerEvents, runningRound, subscribeAnswers } from "../lib/answer-log";
import { clipPlayer, cutClip, playClip } from "../lib/audio";
import { MeetingComments } from "../lib/comments";
import { callerActor } from "../lib/decision-journal";
import type { Finding } from "../lib/findings";
import { personKey, personPresent } from "../lib/listen-answers";
import {
    type ClipSettings,
    clipSettings,
    type ListenSettings,
    questionClip,
    refineSplitClip,
    writeQuestionClips,
} from "../lib/listen-clips";
import { listenQuestionFindings, selectedQuestionIds } from "../lib/listen-input";
import { addQualityQuestions, clipProgress, qualityVoiceFeatures } from "../lib/listen-quality";
import {
    type AskedQuestion,
    type ListenAdapter,
    type ListenOutcome,
    ListenSession,
    type SessionNote,
} from "../lib/listen-session";
import { GivenAnswerAdapter } from "../lib/listen-session-answer";
import { OpenedMeeting } from "../lib/opened-meeting";
import {
    answerVocabulary,
    type HeardContext,
    NONE_OF_THESE,
    openQuestions,
    type QuestionItem,
    questionIdOf,
    questionLabel,
    questionView,
} from "../lib/questions";
import { speakerAnswerScores } from "../lib/review-rows";
import { openMeetingsClient } from "../lib/service/client";
import { fail, TOOL } from "../lib/shared";
import { enrolMeetingVoices } from "../lib/voice-enrolment";

const PAD_CHOICES = [5, 10] as const;
const AGAIN = "\u0000again";
const OTHER = "\u0000other";
const COMMENT = "\u0000comment";
const PAUSE = "\u0000pause";
const SKIP = "\u0000skip";
const STOP = "\u0000stop";
const SPLIT = "\u0000split";
const DEFAULT_SUBSCRIBE_MINUTES = 120;
const SAID_MAX_CHARS = 240;

/**
 * The first `listen` asks how much audio to hear around a range and keeps the answer on both sides; each side is its
 * own setting afterwards (`playback.listen.padBeforeSec`, `padAfterSec`).
 */
async function askedPads(config: MeetingsConfigStore): Promise<ListenPads | undefined> {
    const saved = listenPads((await config.read()).global.playback.listen);

    if (saved) {
        return saved;
    }

    const picked = await clack.select({
        message: "How much audio around each question? (saved as playback.listen.padBeforeSec and padAfterSec)",
        options: PAD_CHOICES.map((sec) => ({ value: sec, label: `${sec} seconds` })),
    });

    if (clack.isCancel(picked)) {
        return undefined;
    }

    const pads = { beforeSec: Number(picked), afterSec: Number(picked) };
    await config.setListenPads(pads);
    return pads;
}

/**
 * "Something else": pick a known name or word, or type a new one: the typed text is always the first row, so Enter
 * takes it when nothing matches. Esc returns undefined (back to the choices).
 */
async function somethingElse(vocabulary: string[], context: string[]): Promise<string | undefined> {
    const picked = await searchSelect<string>({
        message: ["Search or own comment:", ...context].join("\n"),
        items: vocabulary.map((value) => ({ value, label: value })),
        typed: {
            label: (query) => {
                const matched = vocabulary.find((name) => personKey(name) === personKey(query));
                return matched
                    ? "Use " + matched
                    : query
                      ? "Use '" + query + "' as typed"
                      : "Type to filter, or type a new answer";
            },
            resolve: (query) =>
                vocabulary.find((name) => personKey(name) === personKey(query)) ?? (query.trim() || undefined),
        },
    });
    return typeof picked === "symbol" ? undefined : picked;
}

/** The words around a word question's heard words: the line before (dim), the line with them marked, the line after. */
function contextLines(context: HeardContext): string[] {
    return [
        context.before ? pc.dim(context.before) : undefined,
        `${context.lead}${heardMark(context.heard)}${context.rest}`,
        context.after ? pc.dim(context.after) : undefined,
    ].filter((line) => line !== undefined);
}

/**
 * The asked question's rows: its answers first, then the actions, each with its glyph and colour. An answer the engine
 * scored shows its confidence ("72 %", R49), as the window's row does.
 */
function choiceRows(options: {
    question: QuestionItem;
    choices: string[];
    earlier?: { answer: string; atSec: number };
    scores?: Map<string, number>;
}): ChoiceRow<string>[] {
    const { question, earlier } = options;
    const hintOf = (choice: string) => {
        const score = options.scores?.get(choice);
        const hints = [
            ...(score === undefined ? [] : [`${Math.round(score * 100)} %`]),
            ...(earlier && choice === earlier.answer ? [`as at ${formatClock(earlier.atSec)}`] : []),
        ];
        return hints.length > 0 ? { hint: hints.join(" · ") } : {};
    };
    return [
        ...options.choices.map((choice) => ({
            value: choice,
            label: choice,
            kind: "answer" as const,
            ...hintOf(choice),
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
            label: question.about === "speaker" ? "Somebody else…" : "Something else…",
            hint: "pick a known name or word, or type a new one",
            kind: "action",
            glyph: "✎",
            paint: pc.magenta,
        },
        {
            value: COMMENT,
            label: "Something else…",
            hint: "leave a comment; keep this question open",
            kind: "action",
            glyph: "✎",
        },
        {
            value: PAUSE,
            label: "Pause / resume (space)",
            kind: "action",
            glyph: "⏯",
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
    /** The confidence of each answer the engine scored (a speaker question's candidates, G31). */
    scores?: Map<string, number>;
    /** The styled header line: question number, progress and time range. */
    header?: string;
    plan: ReturnType<typeof questionClip>;
}): Promise<ListenOutcome> {
    const { question, earlier } = options;
    const repeat = options.repeatGapMs === undefined ? {} : { repeatGapMs: options.repeatGapMs };
    let playing = playClip(options.player, options.clip, { delayMs: options.delayMs, ...repeat });
    let paused = false;
    const togglePause = () => {
        if (paused) {
            playing.resume();
        } else {
            playing.pause();
        }
        paused = !paused;
    };
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
                rows: choiceRows({
                    question,
                    choices,
                    ...(earlier ? { earlier } : {}),
                    ...(options.scores ? { scores: options.scores } : {}),
                }),
                formatSubmitted: (row) => row.label,
                onSpace: togglePause,
                liveContext: () => [
                    clipProgress({
                        duration:
                            options.plan.toSec -
                            options.plan.fromSec +
                            options.plan.padSec +
                            (options.plan.padAfterSec ?? options.plan.padSec),
                        position: playing.positionSec,
                        askedFrom: options.plan.padSec,
                        askedTo: options.plan.padSec + options.plan.toSec - options.plan.fromSec,
                        tone:
                            options.plan.toneAtSec === undefined
                                ? undefined
                                : options.plan.toneAtSec - options.plan.fromSec + options.plan.padSec,
                    }),
                ],
                footer: "↑↓ move  enter pick  esc back  space pause/resume",
            });

            if (clack.isCancel(picked)) {
                return "back";
            }

            if (picked === STOP || picked === SKIP) {
                return picked === STOP ? "stop" : "skip";
            }
            if (picked === SPLIT) {
                playing.stop();
                const voices = await clack.multiselect({
                    message: "Pick the voices in speaking order (space selects, enter continues):",
                    options: [...new Set([...choices, ...options.vocabulary])].map((name) => ({
                        value: name,
                        label: name,
                    })),
                    required: true,
                });
                if (clack.isCancel(voices)) {
                    playing = playClip(options.player, options.clip, repeat);
                    paused = false;
                    continue;
                }
                return { answer: voices.join(", then ") };
            }

            if (picked === AGAIN) {
                playing.stop();
                playing = playClip(options.player, options.clip, repeat);
                paused = false;
                continue;
            }

            if (picked === PAUSE) {
                togglePause();
                continue;
            }
            if (picked === COMMENT) {
                playing.stop();
                const comment = await clack.text({ message: "Your comment:" });
                if (!clack.isCancel(comment) && comment?.trim()) {
                    return { answer: "", comment: comment.trim() };
                }
                playing = playClip(options.player, options.clip, repeat);
                paused = false;
                continue;
            }
            if (picked === OTHER) {
                playing.stop();
            }
            const answer =
                picked === OTHER
                    ? await somethingElse([...new Set([...choices, ...options.vocabulary])], shown)
                    : String(picked);

            if (!answer) {
                playing = playClip(options.player, options.clip, repeat);
                paused = false;
                continue;
            }

            playing.stop();
            const comment = await clack.text({
                message: `Comment (optional) ${pc.dim("(Esc: back to the choices)")}`,
                placeholder: "Enter to skip",
            });

            if (clack.isCancel(comment)) {
                playing = playClip(options.player, options.clip, repeat);
                paused = false;
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

    // A listener for comments waits for them even with no question open.
    if (!opts.follow && !roundRunning && !opts.fromStart && !opts.withComments && openQuestions(meeting).length === 0) {
        process.stderr.write(`No open questions in ${meeting.id} and no listen round running.\n`);
        return;
    }

    const minutes = opts.timeout === undefined ? DEFAULT_SUBSCRIBE_MINUTES : Number(opts.timeout);

    if (!Number.isFinite(minutes) || minutes <= 0) {
        fail(`--timeout takes minutes, more than 0 (got "${opts.timeout}").`);
        return;
    }

    const write = (line: string): void => out.print(`${line}\n`);
    // `--with-comments`: this process counts as a listener while it runs (a sender names it), and prints each comment.
    const comments = opts.withComments ? MeetingComments.of(store, meeting.id) : undefined;
    comments?.join({ pid: process.pid, actor: callerActor() });
    const following = comments?.follow({ fromStart: opts.fromStart === true, write });

    try {
        process.exitCode = await subscribeAnswers({
            path,
            fromStart: opts.fromStart === true,
            timeoutMs: minutes * 60_000,
            write,
            follow: opts.follow === true,
            ...(comments ? { typed: true } : {}),
        });
    } finally {
        following?.stop();
        comments?.leave(process.pid);
    }
}

interface ListenOptions {
    questions?: string;
    item?: string;
    answer?: string;
    except?: string[];
    replaces?: string;
    comment?: string;
    reason?: string;
    subscribeAnswers?: boolean;
    withComments?: boolean;
    follow?: boolean;
    fromStart?: boolean;
    timeout?: string;
    clipOut?: string;
    json?: boolean;
    enrolVoices?: boolean;
    prepareOnly?: boolean;
    spotCheck?: string;
    longStretchWords?: string;
    group?: string;
    applyAbove?: string;
}

/** `--clip-out <dir>`: the questions' clips as files. No sound, no terminal and no round, so nothing is changed (MC22). */
async function clipsOut(options: {
    store: MeetingStore;
    meeting: MeetingRecord;
    questions: QuestionItem[];
    dir: string;
    json?: boolean;
}): Promise<void> {
    const { store, meeting } = options;
    const listen = (await new MeetingsConfigStore().read()).global.playback.listen;
    const opened = OpenedMeeting.of(store, meeting);
    // A file needs no prompt: the saved pads, else the smaller choice the first listen offers.
    const pads = listenPads(listen) ?? { beforeSec: PAD_CHOICES[0], afterSec: PAD_CHOICES[0] };
    const written = await writeQuestionClips({
        record: meeting,
        questions: options.questions,
        transcript: new TranscriptLines((await opened.meeting()).transcript),
        ...(await clipSettings(listen, pads)),
        audioPath: await opened.audioPath(),
        dir: resolve(options.dir),
    });

    if (options.json) {
        out.result(SafeJSON.stringify(written, null, 2));
        return;
    }

    for (const clip of written) {
        const tone = clip.toneAtSec === undefined ? "" : `, tone at ${formatClock(clip.toneAtSec)}`;
        out.println(`${clip.question} ${clip.clip} (${formatClock(clip.fromSec)}–${formatClock(clip.toSec)}${tone})`);
    }
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
            listen: ListenSettings;
            clips: ClipSettings;
        }
    ) {}

    async ask(asked: AskedQuestion): Promise<ListenOutcome> {
        const { store, meeting, transcript, listen } = this.deps;
        const question =
            asked.question.about === "speaker"
                ? {
                      ...asked.question,
                      choices: asked.question.choices.filter((name) =>
                          personPresent(asked.record, name, asked.question.fromSec)
                      ),
                  }
                : asked.question;
        const view = questionView(asked.record, question, transcript, SAID_MAX_CHARS);
        const clip = join(store.folder(meeting.id), "listen", `${question.id}.wav`);
        const plan = await refineSplitClip({
            plan: questionClip({ record: asked.record, question, transcript, ...this.deps.clips }),
            question,
            audioPath: this.deps.audioPath,
        });
        await cutClip({
            audioPath: this.deps.audioPath,
            outPath: clip,
            ...plan,
        });
        const part = asked.part ? ` · part ${asked.part.n}/${asked.part.of}` : "";
        const priority =
            (view.priority === undefined ? "" : ` · priority ${view.priority}`) +
            (typeof question.evidence?.reach === "number" ? ` · affects ${question.evidence.reach} ranges` : "");
        return await ask({
            question,
            clip,
            plan,
            player: this.deps.player,
            vocabulary: this.deps.vocabulary.filter((name) => personPresent(asked.record, name, question.fromSec)),
            delayMs: listen.delaySec * 1000,
            ...(listen.repeat.enabled ? { repeatGapMs: listen.repeat.gapSec * 1000 } : {}),
            ...(view.said ? { said: view.said } : {}),
            ...(view.context ? { context: view.context } : {}),
            ...(asked.earlier ? { earlier: asked.earlier } : {}),
            scores: speakerAnswerScores(asked.record, question),
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
            ui.ok(
                note.outcome === "skip"
                    ? `${note.label} skipped`
                    : `${note.label} → ${note.outcome.answer || "comment saved; still open"}\n`
            );

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

        if (note.kind === "not-undone") {
            ui.warn(`${note.label} keeps its answer: ${note.reason}`);
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

interface AdapterContext {
    store: MeetingStore;
    meeting: MeetingRecord;
    opened: OpenedMeeting;
    opts: ListenOptions;
    first: QuestionItem;
    settings: MeetingsConfig;
}

/**
 * The adapter the session asks through, the budget it gets, whether it joins a round already running, and who decides:
 * the person in the terminal, or whoever runs `--answer` (an agent relaying a person, or a person at a command).
 */
interface AdapterChoice {
    adapter: ListenAdapter;
    budget: number;
    joinRunningRound?: boolean;
    actor: DecisionActor;
}

const ADAPTERS: Record<"terminal" | "answer", (context: AdapterContext) => Promise<AdapterChoice | undefined>> = {
    answer: async ({ opts }) => {
        if (!opts.item || opts.answer === undefined) {
            fail(`--answer needs --item <Q12>: it answers one question.`);
            return undefined;
        }

        const answer = { answer: opts.answer, ...(opts.comment ? { comment: opts.comment } : {}) };
        const adapter = new GivenAnswerAdapter(answer, (line, tone) =>
            tone === "ok" ? process.stderr.write(`${line}\n`) : ui.dim(line)
        );
        return { adapter, budget: 1, joinRunningRound: true, actor: callerActor() };
    },
    terminal: async ({ store, meeting, opened, first, settings }) => {
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

        const pads = await askedPads(new MeetingsConfigStore());

        if (pads === undefined) {
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
            audioPath: await opened.audioPath(),
            player,
            vocabulary: answerVocabulary(
                meeting,
                dictionary.entries.map((entry) => entry.value),
                await meetingPeopleNames({ store, config: settings, meeting: meeting.id })
            ),
            transcript: new TranscriptLines((await opened.meeting()).transcript),
            listen,
            clips: await clipSettings(listen, pads),
        });
        return { adapter, budget: listen.roundCap, actor: { kind: "listen" } };
    },
};

async function listen(ref: string, opts: ListenOptions): Promise<void> {
    if (!opts.subscribeAnswers && (opts.withComments || opts.fromStart || opts.follow)) {
        fail("--with-comments, --from-start and --follow require --subscribe-answers.");
        return;
    }

    const store = new MeetingStore();
    let meeting: MeetingRecord | undefined;

    try {
        meeting = store.resolve(ref);
    } catch (err) {
        fail(err);
        return;
    }

    if (!meeting) {
        fail(`No meeting "${ref}". List them: ${TOOL} list`);
        return;
    }

    const applyAbove = opts.applyAbove === undefined ? undefined : Number(opts.applyAbove) / 100;
    if (applyAbove !== undefined && (!Number.isFinite(applyAbove) || applyAbove < 0 || applyAbove > 1)) {
        fail("--apply-above must be a percentage between 0 and 100");
        return;
    }
    if (opts.enrolVoices) {
        const result = await enrolMeetingVoices({ opened: OpenedMeeting.of(store, meeting), store });
        out.result(SafeJSON.stringify(result));
        return;
    }
    const group = opts.group ?? (opts.spotCheck ? "spot-check" : opts.longStretchWords ? "long-stretch" : "all");
    if (!["all", "rules", "spot-check", "long-stretch"].includes(group)) {
        fail("--group must be rules, spot-check, long-stretch or all");
        return;
    }
    if (opts.spotCheck || opts.longStretchWords) {
        const entries = (await OpenedMeeting.of(store, meeting).meeting()).transcript;
        const spotCheck = opts.spotCheck === undefined ? undefined : Number(opts.spotCheck);
        const longStretchWords = opts.longStretchWords === undefined ? undefined : Number(opts.longStretchWords);
        if (
            [spotCheck, longStretchWords].some(
                (value) => value !== undefined && (!Number.isInteger(value) || value <= 0)
            )
        ) {
            fail("Spot-check count and long-stretch word count must be positive integers");
            return;
        }
        const opened = OpenedMeeting.of(store, meeting);
        const features = opts.longStretchWords ? await qualityVoiceFeatures(opened) : undefined;
        meeting = await store.update(meeting.id, { command: "listen", change: "quality question groups" }, (record) => {
            addQualityQuestions({
                record,
                entries,
                spotCheck,
                longStretchWords,
                features,
                channel: record.evidence?.channels?.layout === "right-mic" ? 0 : 1,
                below: opts.applyAbove ? Number(opts.applyAbove) / 100 : undefined,
            });
        });
    }
    if (opts.prepareOnly) {
        out.result(
            SafeJSON.stringify({
                meeting: meeting.id,
                questions: openQuestions(meeting)
                    .filter((question) => group === "all" || (question.group ?? "rules") === group)
                    .map((question) => question.id),
            })
        );
        return;
    }
    let selected: string[] | undefined =
        group === "all"
            ? undefined
            : openQuestions(meeting)
                  .filter((question) => (question.group ?? "rules") === group)
                  .map((question) => question.id);
    for (const name of ["rules", "spot-check", "long-stretch"]) {
        ui.dim(name + ": " + openQuestions(meeting).filter((question) => (question.group ?? "rules") === name).length);
    }
    if (opts.subscribeAnswers) {
        await subscribe(meeting, store, opts);
        return;
    }

    if (opts.answer !== undefined && !opts.clipOut) {
        if (!opts.item) {
            fail("--answer needs --item <Q12>: it answers one question.");
            return;
        }

        const client = await openMeetingsClient({ role: "cli" });
        try {
            const result = await client.call("decision.apply", {
                meeting: meeting.id,
                action: {
                    kind: "answer",
                    question: opts.item,
                    answer: opts.answer,
                    ...(opts.comment ? { comment: opts.comment } : {}),
                    ...(opts.except ? { except: opts.except } : {}),
                    ...(opts.replaces ? { replaces: opts.replaces } : {}),
                },
                ...(opts.reason ? { reason: opts.reason } : {}),
            });
            if (!result.entry) {
                fail(result.skipped[0]?.reason ?? "Nothing was answered.");
            } else if (opts.json) {
                out.result(SafeJSON.stringify(result.entry, null, 2));
            } else {
                const answered = result.entry.changes.find((change) => change.after?.kind === "question")?.after;
                ui.ok(
                    `${opts.item} → ${answered?.kind === "question" && answered.status === "confirmed" ? answered.answer : "comment saved; still open"}\n`
                );
            }
        } catch (error) {
            fail(error);
        } finally {
            client.close();
        }
        return;
    }

    if (opts.except || opts.replaces) {
        fail("--except and --replaces need --answer and --item.");
        return;
    }

    let pendingFindings: Finding[] | undefined;
    try {
        if (opts.questions) {
            if (opts.item || opts.answer !== undefined) {
                throw new Error("--questions cannot be combined with --item or --answer");
            }
            if (/^(?:Q\d+|i\d+)(?:,(?:Q\d+|i\d+))*$/i.test(opts.questions)) {
                selected = selectedQuestionIds(meeting, opts.questions.split(","));
            } else {
                if (opts.clipOut || !isInteractive()) {
                    throw new Error(
                        "Ad-hoc questions are stored when an interactive round starts; --clip-out and noninteractive use require stored question IDs"
                    );
                }
                let text: string;
                if (opts.questions === "-") {
                    const input = createInterface({ input: process.stdin, output: process.stderr });
                    try {
                        text = await input.question("Questions JSON array: ");
                    } finally {
                        input.close();
                    }
                } else {
                    text = await Bun.file(opts.questions).text();
                }
                pendingFindings = listenQuestionFindings(SafeJSON.parse(text));
                const prepared = prepareFindings({ findings: pendingFindings, items: meeting.items });
                meeting = { ...meeting, items: [...meeting.items, ...prepared.added] };
            }
        }
    } catch (error) {
        fail(error);
        return;
    }

    const itemId = opts.item ? questionIdOf(meeting, opts.item) : undefined;
    const first = openQuestions(meeting).find(
        (item) => (!itemId || item.id === itemId) && (!selected || selected.includes(item.id))
    );

    if (!first) {
        // A named question that is not open was not answered, so that exits 1; an empty round is no failure.
        opts.item
            ? fail(
                  `${opts.item} is not an open question in ${meeting.id} (${TOOL} items ${meeting.id} --kind question)`
              )
            : ui.info(`No open questions in ${meeting.id}. Suggest some: ${TOOL} suggest ${meeting.id}`);
        return;
    }

    if (opts.clipOut) {
        if (opts.answer !== undefined) {
            fail("--clip-out only writes the clips; leave out --answer, or answer in another call.");
            return;
        }

        try {
            const questions = openQuestions(meeting).filter(
                (item) => (!itemId || item.id === itemId) && (!selected || selected.includes(item.id))
            );
            await clipsOut({ store, meeting, questions, dir: opts.clipOut, json: opts.json });
        } catch (err) {
            fail(err);
        }

        return;
    }

    try {
        const settings = await new MeetingsConfigStore().read();
        const opened = OpenedMeeting.of(store, meeting);
        const chosen = await ADAPTERS[opts.answer === undefined ? "terminal" : "answer"]({
            store,
            meeting,
            opened,
            opts,
            first,
            settings,
        });

        if (!chosen) {
            return;
        }

        if (pendingFindings) {
            const adding = await openMeetingsClient({ role: "listen" });
            try {
                await adding.call("decision.apply", {
                    meeting: meeting.id,
                    action: { kind: "add", findings: pendingFindings },
                });
                meeting = store.read(meeting.id) ?? meeting;
            } finally {
                adding.close();
            }
        }

        // The round decides through the Meetings service when one runs (the window hears each answer as it lands),
        // else in this process: the person in this terminal as `listen`, an `--answer` as whoever runs it.
        const client = await openMeetingsClient({ role: opts.answer === undefined ? "listen" : "cli" });
        const session = new ListenSession({
            store,
            meeting,
            logPath: join(store.folder(meeting.id), ANSWER_LOG_FILE),
            adapter: chosen.adapter,
            ...(itemId ? { only: itemId } : {}),
            budget: opts.spotCheck ? Number(opts.spotCheck) : chosen.budget,
            ...(selected ? { selected } : {}),
            minPriority: settings.global.playback.listen.minPriority,
            listenBelow: settings.global.suggest.listenBelow,
            ...(chosen.joinRunningRound ? { joinRunningRound: true } : {}),
            actor: chosen.actor,
            ...(opts.reason ? { reason: opts.reason } : {}),
            decisions: {
                apply: (request) => client.call("decision.apply", request),
                revert: (request) => client.call("decision.revert", request),
            },
            split: {
                transcript: async () => (await opened.meeting()).transcript,
                micShare: async () => (await opened.energy()).share,
            },
        });
        // Ctrl-C outside a prompt (while a clip is cut) ends the process; the exit handler still closes the round.
        const onExit = (): void => session.end("aborted");
        const onSigint = (): void => process.exit(130);
        process.once("exit", onExit);
        process.once("SIGINT", onSigint);

        try {
            await session.run();
            if (opts.spotCheck) {
                const roundIds = new Set(selected ?? session.applied().flatMap((entry) => entry.decided));
                const sample =
                    store
                        .read(meeting.id)
                        ?.items.filter(
                            (item) =>
                                roundIds.has(item.id) &&
                                item.kind === "question" &&
                                item.group === "spot-check" &&
                                item.status === "confirmed"
                        ) ?? [];
                const changed = sample.filter(
                    (item) => item.kind === "question" && item.answer !== item.evidence?.originalSpeaker
                ).length;
                await store.update(meeting.id, { command: "listen", change: "spot-check result" }, (record) => {
                    record.review ??= {};
                    record.review.listen ??= {};
                    record.review.listen.spotChecks ??= [];
                    record.review.listen.spotChecks.push({
                        at: new Date().toISOString(),
                        answered: sample.length,
                        changed,
                        questionIds: sample.map((item) => item.id),
                    });
                });
                ui.info(
                    "Spot check: " +
                        changed +
                        "/" +
                        sample.length +
                        " changed" +
                        (sample.length ? " (" + Math.round((100 * changed) / sample.length) + " %)" : "")
                );
            }
        } finally {
            process.off("exit", onExit);
            process.off("SIGINT", onSigint);
            client.close();
        }

        // `--answer --json`: the decision journal entry of the answer, for the agent that relayed it.
        if (opts.json && opts.answer !== undefined) {
            const entry = session.applied().at(-1);

            if (!entry) {
                const why = session.skippedLast()[0]?.reason ?? `${opts.item} is not open any more`;
                fail(
                    `${why}; nothing was answered (who decided it: ${TOOL} journal ${meeting.id} --item ${opts.item})`
                );
                return;
            }

            out.result(SafeJSON.stringify(entry, null, 2));
        }
    } catch (err) {
        fail(err);
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
        .option(
            "--questions <file|Q12,Q13|->",
            "store ad-hoc question findings from JSON at round start, or select stored questions"
        )
        .option("--apply-above <percent>", "confidence threshold for quality questions")
        .option("--spot-check <n>", "ask a random sample of 50 to 69 percent lines and report the share changed")
        .option(
            "--enrol-voices",
            "enrol remote seats from isolated call audio with an already installed model; score and store line evidence"
        )
        .option(
            "--prepare-only",
            "prepare selected quality questions without playing audio or starting a listening round"
        )
        .option("--long-stretch-words <n>", "ask every guess stretch of this many words or more")
        .option("--group <group>", "rules, spot-check, long-stretch or all")
        .option("--answer <text>", `answer --item without listening ("${NONE_OF_THESE}" rejects what it decides)`)
        .option("--comment <text>", "with --answer: a note kept on the question")
        .option("--except <items...>", "with --answer: leave these item ids or question numbers out")
        .option("--replaces <token>", "with --answer: replace this earlier answer in one decision")
        .option("--reason <text>", "why: kept in the decision journal with each answer")
        .option(
            "--subscribe-answers",
            "for an agent: print each answer as one JSON line while the person answers; exit when the round ends"
        )
        .option(
            "--with-comments",
            'with --subscribe-answers: also print each comment the person sends from the window, one JSON line with type "comment" (every line then has a type)'
        )
        .option("--from-start", "with --subscribe-answers: print every earlier round first")
        .option(
            "--follow",
            "with --subscribe-answers: stay up across rounds (the window answers one question per round) until a round ends with no open question, or --timeout"
        )
        .option(
            "--timeout <minutes>",
            `with --subscribe-answers: give up after this long (default ${DEFAULT_SUBSCRIBE_MINUTES})`
        )
        .option(
            "--clip-out <dir>",
            "cut each open question's clip (only --item's with it) into <dir>/<Q12>.wav as listen plays it; plays nothing and changes nothing"
        )
        .option(
            "--json",
            "with --clip-out: print [{ question, id, clip, fromSec, toSec, padSec, padAfterSec?, toneAtSec }]; with --answer: print the decision journal entry"
        )
        .action(listen);
}

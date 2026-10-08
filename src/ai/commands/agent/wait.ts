import { resolveSessionTranscript } from "@app/ai/lib/sessions/resolve-transcript";
import { transcriptByteSize, transcriptEnvelope, transcriptSnapshot } from "@genesiscz/utils/ai/transcripts/load";
import type { ResolvedTranscript } from "@genesiscz/utils/ai/transcripts/resolve";
import { readTurnState, type TurnProvider, type TurnSnapshot } from "@genesiscz/utils/ai/transcripts/turn-state";
import { type TurnWaitOutcome, turnAnswers, watchTurn } from "@genesiscz/utils/ai/transcripts/turn-wait";
import {
    DEFAULT_TURN_LIMIT,
    type SliceOptions,
    type TranscriptEnvelope,
    type TranscriptTurn,
} from "@genesiscz/utils/ai/transcripts/types";
import { formatDuration } from "@genesiscz/utils/format";
import { logger, out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import pc from "picocolors";

const { log } = logger.scoped("agent-wait");

/** The turn ended. Same as any other command that succeeded. */
export const WAIT_EXIT_DONE = 0;
export const WAIT_EXIT_ERROR = 1;
export const WAIT_EXIT_USAGE = 2;
/** The turn is running but the transcript has been silent past `--stall-timeout`. */
export const WAIT_EXIT_STALLED = 3;
/** `--timeout` passed first. 124 is what coreutils `timeout` exits with, so a script can treat both alike. */
export const WAIT_EXIT_TIMEOUT = 124;

/** Default silence that counts as a stall. A long tool call (a test run) is silent too, so this is generous. */
export const DEFAULT_WAIT_STALL_SECONDS = 900;
/** Writes wake the wait at once (shared file watcher); this poll only notices silence and the deadline. */
const POLL_MS = 5000;
/**
 * How far before `sentAt` an answering turn's start may be stamped. Grok stamps records in whole seconds, so its
 * answer can carry the second the message was sent in; Claude and Codex stamp milliseconds and get no tolerance.
 * The turn that was current before the send is excluded on its own (`baselineTurnStartedAt`).
 */
export function sentAtSlackMs(alias: TurnProvider): number {
    return alias === "grok" ? 1000 : 0;
}

export interface WaitOptions {
    timeout?: string;
    stallTimeout?: string;
    next?: boolean;
    stream?: boolean;
    json?: boolean;
    first?: boolean;
    /** Print the last N assistant messages instead of only the final one. */
    last?: string;
    /** Also list the tool calls of the turn that ended. */
    tools?: boolean;
    /** Status line and exit code only; no message text. */
    quiet?: boolean;
    /** Set by `message --wait`: a turn that ended after this instant (epoch ms) counts even if it ended before the wait began. */
    sentAt?: number;
    /**
     * Set by `message --wait`: when the session's latest turn began, read just before the message was delivered.
     * That turn (ended or still running) never answers the message, however close to the send it began.
     */
    baselineTurnStartedAt?: number;
    /** Set by `message --wait`: the sent text. A Grok turn that opened in the baseline's second answers when this is its prompt. */
    sentText?: string;
    /** Set by `message --wait --json`: merged into the one JSON document. */
    embed?: Record<string, unknown>;
}

/** What `--last` and `--tools` add, read from the transcript after the turn ended. */
export interface TurnExtras {
    lastMessages?: string[];
    tools?: { name: string; count: number }[];
}

/** The last `last` assistant texts, and the tool calls since the last user turn, from parsed turns. */
export function turnExtrasOf(
    turns: readonly { role: TranscriptTurn["role"]; text: string; tools: readonly { name: string }[] }[],
    want: { last?: number; tools?: boolean }
): TurnExtras {
    const extras: TurnExtras = {};

    if (want.last !== undefined) {
        extras.lastMessages = turns
            .filter((turn) => turn.role === "assistant" && turn.text.trim() !== "")
            .slice(-want.last)
            .map((turn) => turn.text.trim());
    }

    if (want.tools) {
        let start = 0;

        for (let i = turns.length - 1; i >= 0; i--) {
            if (turns[i].role === "user") {
                start = i + 1;
                break;
            }
        }

        const counts = new Map<string, number>();

        for (const turn of turns.slice(start)) {
            for (const tool of turn.tools) {
                counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
            }
        }

        extras.tools = [...counts].map(([name, count]) => ({ name, count }));
    }

    return extras;
}

/**
 * `--last` and `--tools` from the transcript's tail, paging back from the end until the page set holds `last`
 * assistant texts and the user prompt that began the ending turn, or the transcript's start. One page is
 * DEFAULT_TURN_LIMIT turns, and user and tool-only turns use up part of it.
 */
export async function readTurnExtras(
    page: TranscriptPager,
    want: { last?: number; tools?: boolean }
): Promise<TurnExtras> {
    const tail = await page({});
    const pages = [tail.turns];
    let start = tail.nextOffset - tail.turns.length;
    let texts = 0;
    let sawUser = false;
    const count = (turns: readonly TranscriptTurn[]) => {
        for (const turn of turns) {
            texts += turn.role === "assistant" && turn.text.trim() !== "" ? 1 : 0;
            sawUser ||= turn.role === "user";
        }
    };
    const covered = () => (want.last === undefined || texts >= want.last) && (!want.tools || sawUser);

    count(tail.turns);

    while (start > 0 && !covered()) {
        const offset = Math.max(0, start - DEFAULT_TURN_LIMIT);
        const earlier = await page({ offset, limit: start - offset });

        if (earlier.turns.length === 0) {
            break;
        }

        pages.unshift(earlier.turns);
        count(earlier.turns);
        start = offset;
    }

    return turnExtrasOf(pages.flat(), want);
}

/**
 * Did the turn that answers a sent message already END before the watch starts? Only an ended turn counts
 * (the same states TurnJudge treats as ended): a STALLED turn is unfinished, so it goes through the watch and
 * keeps its stall handling and exit code.
 */
export function answeredBeforeWatch(
    before: TurnSnapshot | null,
    window: { turnStartedAfter?: number; turnNewerThan?: number; prompt?: string }
): boolean {
    return (
        before !== null &&
        window.turnStartedAfter !== undefined &&
        (before.state === "AWAITING-INPUT" || before.state === "FINISHED") &&
        before.turnStartedAt !== null &&
        turnAnswers(before.turnStartedAt, window, before.turnPrompt)
    );
}

/** Is the turn that answers a sent message already under way (started, not ended) when the watch begins? */
export function answerAlreadyRunning(
    before: TurnSnapshot | null,
    window: { turnStartedAfter?: number; turnNewerThan?: number; prompt?: string }
): boolean {
    return (
        before !== null &&
        window.turnStartedAfter !== undefined &&
        (before.state === "RUNNING" || before.state === "STALLED") &&
        before.turnStartedAt !== null &&
        turnAnswers(before.turnStartedAt, window, before.turnPrompt)
    );
}

/** The exit status for an outcome. */
export function exitCodeOf(outcome: TurnWaitOutcome): number {
    if (outcome === "done") {
        return WAIT_EXIT_DONE;
    }

    return outcome === "stalled" ? WAIT_EXIT_STALLED : WAIT_EXIT_TIMEOUT;
}

/** A positive number of seconds, or a thrown usage error naming the flag. */
export function parseSeconds(
    raw: string | undefined,
    flag: string,
    { allowZero }: { allowZero: boolean }
): number | undefined {
    if (raw === undefined) {
        return undefined;
    }

    const value = Number(raw.trim());

    if (!Number.isFinite(value) || value < 0 || (value === 0 && !allowZero)) {
        throw new UsageError(`${flag} must be ${allowZero ? "zero or " : ""}a positive number of seconds (got ${raw})`);
    }

    return value;
}

export class UsageError extends Error {}

export interface WaitFlags {
    timeoutSeconds: number | undefined;
    last: number | undefined;
    /** Infinity for `--stall-timeout 0`. */
    stallTimeoutMs: number;
}

/**
 * `--timeout`, `--stall-timeout` and `--last`, validated, or a thrown UsageError naming the flag. `message --wait`
 * calls it BEFORE it delivers, so a bad flag never leaves a sent message behind an unstarted wait.
 */
export function parseWaitFlags(
    options: Pick<WaitOptions, "timeout" | "stallTimeout" | "last">,
    { timeoutFlag = "--timeout" }: { timeoutFlag?: string } = {}
): WaitFlags {
    const timeoutSeconds = parseSeconds(options.timeout, timeoutFlag, { allowZero: false });
    const last = parseSeconds(options.last, "--last", { allowZero: false });

    if (last !== undefined && !Number.isInteger(last)) {
        throw new UsageError(`--last must be a whole number of messages (got ${options.last})`);
    }

    const stallSeconds =
        parseSeconds(options.stallTimeout, "--stall-timeout", { allowZero: true }) ?? DEFAULT_WAIT_STALL_SECONDS;
    return {
        timeoutSeconds,
        last,
        stallTimeoutMs: stallSeconds === 0 ? Number.POSITIVE_INFINITY : stallSeconds * 1000,
    };
}

/** Live streaming is text output, so --quiet turns it off (with --json too: the one JSON document stays). */
export function streamsLive(options: Pick<WaitOptions, "stream" | "quiet">): boolean {
    return options.stream === true && options.quiet !== true;
}

/**
 * Does the final text still need printing? Not with --quiet, and not when the streamer already showed the turn
 * live. A reply that ended before the watch began never went through the streamer (it was primed past it).
 */
export function printsFinalText(input: { quiet: boolean; streaming: boolean; answeredBeforeWatch: boolean }): boolean {
    if (input.quiet) {
        return false;
    }

    return !input.streaming || input.answeredBeforeWatch;
}

/** One read's pages of a transcript. */
export type TranscriptPager = (opts: SliceOptions) => Promise<TranscriptEnvelope>;

/** Claude reads only the requested turns (turn-index.ts); the others parse once per read and page from memory. */
async function transcriptPager(resolved: ResolvedTranscript): Promise<TranscriptPager> {
    if (resolved.provider === "claude") {
        return (opts) => transcriptEnvelope(resolved, opts);
    }

    const snapshot = await transcriptSnapshot(resolved);
    return async (opts) => snapshot(opts);
}

/** Prints what the agent wrote since the last call. The turns that exist when it is created are history. */
export class TurnStreamer {
    /** What was printed of each recent turn, by turn id: positions shift when a Codex script turn vanishes. */
    private readonly printed = new Map<string, { index: number; text: number; tools: Set<string> }>();
    /** Every turn id read so far. A known turn with no `printed` record was printed whole. */
    private readonly known = new Set<string>();
    /** The last turn read. It can still grow, so the next read starts at it and pages on to the end. */
    private cursor = 0;
    private cursorId: string | null = null;
    private lastSize = -1;
    /** Reads run one at a time: a timeout's final printRest() must not drain beside a print still in flight. */
    private queue: Promise<unknown> = Promise.resolve();

    constructor(
        private readonly options: {
            resolved: ResolvedTranscript;
            write: (line: string) => void;
            /** Tests stand in for the transcript; the defaults read it from disk. */
            pager?: (resolved: ResolvedTranscript) => Promise<TranscriptPager>;
            size?: (resolved: ResolvedTranscript) => number;
        }
    ) {}

    async prime(): Promise<void> {
        await this.serial(() => this.each({ priming: true, visit: () => {} }));
    }

    async print(): Promise<void> {
        await this.serial(() =>
            this.each({
                priming: false,
                visit: (turn) => this.printTurn(turn),
            })
        );
    }

    private serial(task: () => Promise<void>): Promise<void> {
        const run = this.queue.then(task);
        this.queue = run.catch(() => undefined);
        return run;
    }

    /**
     * The last print, once the wait has settled. A failed print does not hold the judge back
     * (turn-wait.ts), so a turn can end with its final write unprinted; this read catches up, and reads
     * nothing when the stream is current. False when it failed too: the live output may miss the end.
     */
    async printRest(): Promise<boolean> {
        try {
            await this.print();
            return true;
        } catch (err) {
            log.warn({ err, file: this.options.resolved.filePath }, "--stream: the final transcript read failed");
            return false;
        }
    }

    private printTurn(turn: TranscriptTurn): void {
        const previous = this.printed.get(turn.id);

        if (!previous && this.known.has(turn.id)) {
            return;
        }

        const fresh = turn.role === "assistant" ? turn.text.slice(previous?.text ?? 0) : "";

        if (fresh.trim()) {
            this.options.write(fresh.trimEnd());
        }

        for (const tool of turn.tools) {
            if (!previous?.tools.has(tool.id)) {
                this.options.write(pc.dim(`→ ${tool.name}(${tool.inputPreview.slice(0, 120)})`));
            }
        }
    }

    /**
     * Where a print starts reading: the cursor's turn, wherever it is now. Codex drops an assistant turn
     * whose only content was an `exec` script that finished with nothing to show (codex.ts `snapshot`), so
     * the turns after it move down and the cursor's turn can leave its position, or vanish. Turns are only
     * ever dropped or appended, so the last known turn before the cursor's position is where reading resumes:
     * every turn after it is new.
     */
    private async resumeAt(page: TranscriptPager): Promise<number> {
        let end = this.cursor;

        while (end > 0) {
            const from = Math.max(0, end - DEFAULT_TURN_LIMIT);
            const envelope = await page({ offset: from, limit: end - from });
            const start = envelope.nextOffset - envelope.turns.length;

            for (let position = envelope.turns.length - 1; position >= 0; position--) {
                if (this.known.has(envelope.turns[position].id)) {
                    return start + position;
                }
            }

            end = from;
        }

        return 0;
    }

    /**
     * The size is checked before any parse, so a safety poll on a quiet file reads nothing. Priming reads the
     * tail page only (its turns are history); a print starts at the cursor and drains every page after it, so
     * a burst of more turns than one page holds still prints whole. A failed read commits nothing, so the
     * next call retries the same size.
     */
    private async each(args: { priming: boolean; visit: (turn: TranscriptTurn) => void }): Promise<void> {
        const { resolved } = this.options;
        const size = (this.options.size ?? transcriptByteSize)(resolved);

        if (size === this.lastSize) {
            return;
        }

        const page = await (this.options.pager ?? transcriptPager)(resolved);
        let envelope = await page(args.priming ? {} : { offset: this.cursor, limit: DEFAULT_TURN_LIMIT });

        if (!args.priming && this.cursorId !== null && envelope.turns[0]?.id !== this.cursorId) {
            envelope = await page({ offset: await this.resumeAt(page), limit: DEFAULT_TURN_LIMIT });
        }

        while (true) {
            const start = envelope.nextOffset - envelope.turns.length;

            for (const [position, turn] of envelope.turns.entries()) {
                args.visit(turn);
                this.known.add(turn.id);
                this.printed.set(turn.id, {
                    index: start + position,
                    text: turn.text.length,
                    tools: new Set(turn.tools.map((tool) => tool.id)),
                });
            }

            const last = envelope.turns.at(-1);

            if (last) {
                this.cursor = envelope.nextOffset - 1;
                this.cursorId = last.id;
            }

            const atEnd = envelope.nextOffset >= (envelope.turnCount ?? envelope.nextOffset);

            if (args.priming || envelope.turns.length === 0 || atEnd) {
                break;
            }

            envelope = await page({ offset: envelope.nextOffset, limit: DEFAULT_TURN_LIMIT });
        }

        // Only the cursor's turn can still grow; the ones before it are printed whole.
        for (const [id, record] of this.printed) {
            if (record.index < this.cursor) {
                this.printed.delete(id);
            }
        }

        // Committed only after a whole drain: a read that throws leaves the size unseen, so the next
        // poll retries from the cursor instead of skipping a write it never printed.
        this.lastSize = size;
    }
}

interface WaitReport {
    outcome: TurnWaitOutcome;
    state: TurnSnapshot["state"] | null;
    provider: TurnProvider;
    sessionId: string;
    filePath: string;
    lastText: string;
    asksQuestion: boolean;
    interrupted: boolean;
    /** Questions the agent asked while it kept working (it did not stop for an answer). */
    questions: string[];
    durationMs: number;
    silenceMs: number | null;
    lastEventAt: string | null;
}

function reportOf(args: {
    outcome: TurnWaitOutcome;
    snapshot: TurnSnapshot | null;
    resolved: ResolvedTranscript;
    provider: TurnProvider;
    waitedMs: number;
    questions: string[];
}): WaitReport {
    const { snapshot } = args;

    return {
        outcome: args.outcome,
        state: snapshot?.state ?? null,
        provider: args.provider,
        sessionId: args.resolved.sessionId,
        filePath: args.resolved.filePath,
        lastText: snapshot?.lastText ?? "",
        asksQuestion: snapshot?.asksQuestion ?? false,
        interrupted: snapshot?.interrupted ?? false,
        questions: args.questions,
        durationMs: args.waitedMs,
        silenceMs: snapshot?.silenceMs ?? null,
        lastEventAt: snapshot?.lastEventAt ? new Date(snapshot.lastEventAt).toISOString() : null,
    };
}

function statusLine(report: WaitReport): string {
    const id = report.sessionId.slice(0, 8);
    const waited = formatDuration(report.durationMs, "ms");

    if (report.outcome === "done") {
        const question = report.asksQuestion
            ? " (ended on a question for the user)"
            : report.interrupted
              ? " (the user interrupted the turn)"
              : "";

        return `${report.provider} ${id}: ${report.state} after ${waited}${question}`;
    }

    if (report.outcome === "stalled") {
        return `${report.provider} ${id}: STALLED, no transcript write for ${formatDuration(report.silenceMs ?? 0, "ms")}`;
    }

    return `${report.provider} ${id}: still ${report.state ?? "empty"} after ${waited} (timeout)`;
}

/**
 * The session's latest turn before a message is sent, for `message --wait`: that turn never answers the message.
 * Null when the session cannot be resolved here (delivery may still find it by a cmux title), which falls back to
 * the send time alone.
 */
export async function readTurnBaseline(
    alias: TurnProvider,
    query: string,
    first: boolean
): Promise<{ sessionId: string; turnStartedAt: number | null } | null> {
    try {
        const resolved = await resolveSessionTranscript(alias, query, first);
        const snapshot = readTurnState(alias, resolved.filePath, { stallTimeoutMs: Number.POSITIVE_INFINITY });
        return { sessionId: resolved.sessionId, turnStartedAt: snapshot?.turnStartedAt ?? null };
    } catch (error) {
        log.debug({ error, alias, query }, "no turn baseline before the send; the send time alone decides");
        return null;
    }
}

/** The baseline's turn start, when the baseline is of the session the message went to. */
export function baselineStartFor(
    baseline: { sessionId: string; turnStartedAt: number | null } | null,
    deliveredTo: string
): number | undefined {
    return baseline?.sessionId === deliveredTo && baseline.turnStartedAt !== null ? baseline.turnStartedAt : undefined;
}

export async function waitCommand(alias: TurnProvider, query: string, options: WaitOptions): Promise<void> {
    try {
        const { timeoutSeconds, last, stallTimeoutMs } = parseWaitFlags(options);
        const resolved = await resolveSessionTranscript(alias, query, options.first === true);
        const read = (): TurnSnapshot | null => readTurnState(alias, resolved.filePath, { stallTimeoutMs });
        // With --json, stdout carries one JSON document, so the live text goes to stderr.
        const streamTo = options.json ? (line: string) => out.printlnErr(line) : (line: string) => out.println(line);
        let streamer = streamsLive(options) ? new TurnStreamer({ resolved, write: streamTo }) : null;

        await streamer?.prime();
        log.debug(
            { alias, query, file: resolved.filePath, timeoutSeconds, stallTimeoutMs, next: options.next },
            "waiting for a turn"
        );

        // `message --wait`: the reply may already be over (a fast agent). Only a turn that BEGAN after the send
        // answers it: a busy Codex session queues the message behind its current turn, whose end is not the reply.
        // The turn that was current before the send never answers; Grok's whole-second stamps get one second of
        // tolerance below the send, the millisecond clocks none.
        const window = {
            turnStartedAfter: options.sentAt !== undefined ? options.sentAt - sentAtSlackMs(alias) : undefined,
            turnNewerThan: options.baselineTurnStartedAt,
            prompt: options.sentText,
        };
        const before = window.turnStartedAfter !== undefined ? read() : null;
        const alreadyAnswered = answeredBeforeWatch(before, window);

        // The answering turn may already be running with text written before the streamer was primed, which marked
        // that text as history. Its live tail alone would cut the reply's beginning, so print it whole at the end.
        if (streamer && answerAlreadyRunning(before, window)) {
            log.debug({ file: resolved.filePath }, "the reply started before the stream; printing it whole at the end");
            streamer = null;
        }

        const result = alreadyAnswered
            ? { outcome: "done" as const, snapshot: before, waitedMs: 0, questions: [] }
            : await watchTurn({
                  path: resolved.filePath,
                  read,
                  next: options.next === true,
                  turnStartedAfter: window.turnStartedAfter,
                  turnNewerThan: window.turnNewerThan,
                  prompt: window.prompt,
                  timeoutMs: timeoutSeconds === undefined ? undefined : timeoutSeconds * 1000,
                  pollMs: POLL_MS,
                  onSnapshot: async () => {
                      await streamer?.print();
                  },
              });

        if (streamer && !(await streamer.printRest())) {
            out.printlnErr(
                pc.yellow("--stream: the last transcript read failed, so the output above may miss the end")
            );
        }

        const report = reportOf({ ...result, resolved, provider: alias, waitedMs: result.waitedMs });
        const extras =
            last !== undefined || options.tools
                ? await readTurnExtras(await transcriptPager(resolved), { last, tools: options.tools })
                : {};

        process.exitCode = exitCodeOf(result.outcome);

        if (options.json) {
            out.result({ ...options.embed, ...report, ...extras });
        } else {
            const printFinal = printsFinalText({
                quiet: options.quiet === true,
                streaming: streamer !== null,
                answeredBeforeWatch: alreadyAnswered,
            });

            if (report.outcome === "done" && printFinal) {
                const texts = extras.lastMessages ?? (report.lastText ? [report.lastText] : []);
                out.println(texts.join("\n\n---\n\n"));
            }

            if (extras.tools && !options.quiet) {
                out.println(
                    pc.dim(`tools: ${extras.tools.map((tool) => `${tool.name} ×${tool.count}`).join(", ") || "none"}`)
                );
            }

            for (const question of report.questions) {
                out.printlnErr(pc.yellow(`asked while working (did not wait for an answer): ${question}`));
            }

            out.printlnErr(statusLine(report));
        }

        await out.flush();
    } catch (error) {
        process.exitCode = error instanceof UsageError ? WAIT_EXIT_USAGE : WAIT_EXIT_ERROR;
        out.error(pc.red(error instanceof Error ? error.message : String(error)));
        await out.flush();
    }
}

export function registerAgentWaitCommand(program: Command, alias: TurnProvider): Command {
    return program
        .command("wait <session>")
        .description(
            `Block until a ${alias} session's current turn ends, reading its transcript (no pane scraping). ` +
                `Exit 0 = turn ended, ${WAIT_EXIT_STALLED} = stalled, ${WAIT_EXIT_TIMEOUT} = --timeout, 1 = error`
        )
        .option("--timeout <seconds>", "Give up after this long and exit 124 (default: wait for ever)")
        .option(
            "--stall-timeout <seconds>",
            `Exit ${WAIT_EXIT_STALLED} when a running turn writes nothing for this long; 0 never (a long tool call is silent too)`,
            String(DEFAULT_WAIT_STALL_SECONDS)
        )
        .option("--next", "If the session is idle now, wait for the NEXT turn to end instead of returning at once")
        .option("--stream", "Print the agent's output while the turn runs (stdout; stderr with --json)")
        .option(
            "--json",
            "Print {outcome,state,sessionId,lastText,asksQuestion,interrupted,questions,durationMs,...} instead of the text"
        )
        .option("--first", "When a title matches several sessions, take the newest instead of failing")
        .option("--last <n>", "Print the last N assistant messages of the session, not only the final one")
        .option("--tools", "Also list the tool calls of the turn that ended (name ×count)")
        .option(
            "--quiet",
            "Print only the status line (stderr) and set the exit code; no message text, and no --stream output. --json still prints its document"
        )
        .addHelpText(
            "after",
            `
<session> is a session id (8+ characters is enough), a transcript path, or a /rename title.
Without --json the final assistant message goes to stdout and one status line to stderr.
An idle session returns at once. A turn that ended on a question for the user exits 0 too:
read "asksQuestion" in --json and never answer a design question for the human.
A question the agent asks while it keeps working (Codex and Grok do this) does not end the wait;
it is listed in "questions" (and on stderr) when the turn ends.`
        )
        .action(async (session: string, options: WaitOptions) => {
            await waitCommand(alias, session, options);
        });
}

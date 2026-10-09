import { transcriptByteSize, transcriptEnvelope, transcriptSnapshot } from "@genesiscz/utils/ai/transcripts/load";
import { type ResolvedTranscript, resolveTranscript } from "@genesiscz/utils/ai/transcripts/resolve";
import { findSessionsByTitle } from "@genesiscz/utils/ai/transcripts/session-title";
import { readTurnState, type TurnProvider, type TurnSnapshot } from "@genesiscz/utils/ai/transcripts/turn-state";
import { type TurnWaitOutcome, watchTurn } from "@genesiscz/utils/ai/transcripts/turn-wait";
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

export interface WaitOptions {
    timeout?: string;
    stallTimeout?: string;
    next?: boolean;
    stream?: boolean;
    json?: boolean;
    first?: boolean;
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

class UsageError extends Error {}

async function resolveByTitle(alias: TurnProvider, query: string, first: boolean): Promise<ResolvedTranscript | null> {
    const hits = findSessionsByTitle(query, { provider: alias });

    if (hits.length === 0) {
        return null;
    }

    if (hits.length > 1 && !first) {
        const lines = hits.slice(0, 6).map((hit) => `  ${hit.sessionId}  ${hit.title}`);
        throw new Error(
            `"${query}" names ${hits.length} ${alias} sessions. Pass the session id, or --first for the newest:\n${lines.join("\n")}`
        );
    }

    return resolveTranscript(hits[0].locator, {}, alias);
}

/**
 * The transcript a query names: a session id (or 8+ character prefix), a transcript path, or a `/rename`
 * title. Native sessions only; a `tools <agent> worker` session has its own verbs.
 */
export async function resolveWaitTranscript(
    alias: TurnProvider,
    query: string,
    first: boolean
): Promise<ResolvedTranscript> {
    let resolved: ResolvedTranscript | null = null;

    try {
        resolved = await resolveTranscript(query, {}, alias);
    } catch (err) {
        log.debug({ err, query, alias }, "no session id or path matched; trying titles");
    }

    // An 8+ character query also matches worker NAMES by substring, so a title can lose to a worker
    // that merely contains it. A native session with that title wins.
    if (!resolved || resolved.source === "worker") {
        resolved = (await resolveByTitle(alias, query, first)) ?? resolved;
    }

    if (!resolved) {
        throw new Error(`No ${alias} session matches "${query}" (tried session id, path and /rename title)`);
    }

    if (resolved.source === "worker") {
        throw new Error(
            `"${query}" is a headless worker session. Use \`tools ${alias} worker\` (or \`tools ${alias} wait\` on a TUI session id).`
        );
    }

    return resolved;
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
    private readonly seen = new Map<number, { text: number; tools: number }>();
    /** The last turn read. It can still grow, so the next read starts at it and pages on to the end. */
    private cursor = 0;
    private lastSize = -1;

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
        await this.each({ priming: true, visit: () => {} });
    }

    async print(): Promise<void> {
        await this.each({
            priming: false,
            visit: (turn) => this.printTurn(turn),
        });
    }

    private printTurn(turn: TranscriptTurn & { index: number }): void {
        const previous = this.seen.get(turn.index) ?? { text: 0, tools: 0 };
        const fresh = turn.role === "assistant" ? turn.text.slice(previous.text) : "";

        if (fresh.trim()) {
            this.options.write(fresh.trimEnd());
        }

        for (const tool of turn.tools.slice(previous.tools)) {
            this.options.write(pc.dim(`→ ${tool.name}(${tool.inputPreview.slice(0, 120)})`));
        }
    }

    /**
     * The size is checked before any parse, so a safety poll on a quiet file reads nothing. Priming reads the
     * tail page only (its turns are history); a print starts at the cursor and drains every page after it, so
     * a burst of more turns than one page holds still prints whole. A failed read commits nothing, so the
     * next call retries the same size.
     */
    private async each(args: {
        priming: boolean;
        visit: (turn: TranscriptTurn & { index: number }) => void;
    }): Promise<void> {
        const { resolved } = this.options;
        const size = (this.options.size ?? transcriptByteSize)(resolved);

        if (size === this.lastSize) {
            return;
        }

        const page = await (this.options.pager ?? transcriptPager)(resolved);
        let opts: SliceOptions = args.priming ? {} : { offset: this.cursor, limit: DEFAULT_TURN_LIMIT };

        while (true) {
            const envelope = await page(opts);
            const start = envelope.nextOffset - envelope.turns.length;

            for (const [position, turn] of envelope.turns.entries()) {
                const index = start + position;
                args.visit({ ...turn, index });
                this.seen.set(index, { text: turn.text.length, tools: turn.tools.length });
            }

            if (envelope.turns.length > 0) {
                this.cursor = envelope.nextOffset - 1;
            }

            const atEnd = envelope.nextOffset >= (envelope.turnCount ?? envelope.nextOffset);

            if (args.priming || envelope.turns.length === 0 || atEnd) {
                break;
            }

            opts = { offset: envelope.nextOffset, limit: DEFAULT_TURN_LIMIT };
        }

        // Only the cursor's turn can still grow; the ones before it are printed whole.
        for (const index of this.seen.keys()) {
            if (index < this.cursor) {
                this.seen.delete(index);
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

export async function waitCommand(alias: TurnProvider, query: string, options: WaitOptions): Promise<void> {
    try {
        const timeoutSeconds = parseSeconds(options.timeout, "--timeout", { allowZero: false });
        const stallSeconds =
            parseSeconds(options.stallTimeout, "--stall-timeout", { allowZero: true }) ?? DEFAULT_WAIT_STALL_SECONDS;
        const stallTimeoutMs = stallSeconds === 0 ? Number.POSITIVE_INFINITY : stallSeconds * 1000;
        const resolved = await resolveWaitTranscript(alias, query, options.first === true);
        const read = (): TurnSnapshot | null => readTurnState(alias, resolved.filePath, { stallTimeoutMs });
        // With --json, stdout carries one JSON document, so the live text goes to stderr.
        const streamTo = options.json ? (line: string) => out.printlnErr(line) : (line: string) => out.println(line);
        const streamer = options.stream ? new TurnStreamer({ resolved, write: streamTo }) : null;

        await streamer?.prime();
        log.debug(
            { alias, query, file: resolved.filePath, timeoutSeconds, stallSeconds, next: options.next },
            "waiting for a turn"
        );

        const result = await watchTurn({
            path: resolved.filePath,
            read,
            next: options.next === true,
            timeoutMs: timeoutSeconds === undefined ? undefined : timeoutSeconds * 1000,
            pollMs: POLL_MS,
            onSnapshot: async () => {
                await streamer?.print();
            },
        });
        const report = reportOf({ ...result, resolved, provider: alias, waitedMs: result.waitedMs });

        process.exitCode = exitCodeOf(result.outcome);

        if (options.json) {
            out.result(report);
        } else {
            if (report.outcome === "done" && !streamer && report.lastText) {
                out.println(report.lastText);
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

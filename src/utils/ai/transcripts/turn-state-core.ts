/**
 * What the three turn-state readers share (`src/utils/agent-sessions/readers/<harness>-turn-state.ts`): the open
 * calls of a turn, the question and tool summaries, and the snapshot a reader returns. No transcript dialect here.
 */
import type {
    OpenToolCall,
    TurnQuestionCall,
    TurnQuestionKind,
    TurnSnapshot,
    TurnStateInput,
} from "@genesiscz/utils/ai/transcripts/turn-state";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { isObject } from "@genesiscz/utils/object";
import { type ActivityEvent, type ActivityState, classifyActivity } from "./activity";
import { parseTranscriptLine } from "./parse-line";

/** The open calls of the current turn, and when the model last got the turn back. One shape for the three readers. */
export class TurnCalls {
    readonly open = new Map<string, OpenToolCall>();
    handedBackAt: number | null = null;

    /** A prompt opened a turn: calls the last one left open are not this turn's. */
    start(ts: number | null): void {
        this.open.clear();
        this.handedBackAt = ts;
    }

    call(call: OpenToolCall): void {
        this.open.set(call.id, call);
    }

    result(id: string, ts: number | null): void {
        this.open.delete(id);

        if (ts !== null) {
            this.handedBackAt = ts;
        }
    }

    end(): void {
        this.open.clear();
    }
}

export function toEpochMs(value: unknown): number | undefined {
    if (typeof value === "number") {
        if (Number.isNaN(value)) {
            return undefined;
        }

        // Grok writes epoch seconds; everything else writes milliseconds or ISO text.
        return value < 1e11 ? value * 1000 : value;
    }

    if (typeof value === "string") {
        const parsed = Date.parse(value);

        return Number.isNaN(parsed) ? undefined : parsed;
    }

    return undefined;
}

/**
 * The first question in a question tool's input: `questions[0].question`, else its `title` or `header`. Exported for
 * the question hooks, which read the same input from the harness payload.
 */
export function questionTextOf(input: unknown): string | null {
    let value = input;

    if (typeof input === "string") {
        try {
            value = SafeJSON.parse(input, { strict: true });
        } catch (err) {
            logger.debug({ err }, "[transcripts] question tool arguments are not JSON; using them as the text");
            return input.trim() || null;
        }
    }

    const first = isObject(value) && Array.isArray(value.questions) ? value.questions[0] : undefined;

    if (!isObject(first)) {
        return null;
    }

    for (const key of ["question", "title", "header"]) {
        const text = first[key];

        if (typeof text === "string" && text.trim()) {
            return text.trim();
        }
    }

    return null;
}

/** How many questions a question tool's input asks (`questions[]`), or undefined when it lists none. */
export function questionCountOf(input: unknown): number | undefined {
    const value = typeof input === "string" ? parseTranscriptLine(input) : input;
    return isObject(value) && Array.isArray(value.questions) && value.questions.length > 0
        ? value.questions.length
        : undefined;
}

/** The option labels of a question tool's first question: `questions[0].options[]`, each a string or `{label}`. */
export function questionOptionsOf(input: unknown): string[] | undefined {
    const value = typeof input === "string" ? parseTranscriptLine(input) : input;
    const first = isObject(value) && Array.isArray(value.questions) ? value.questions[0] : undefined;
    const options: unknown[] = isObject(first) && Array.isArray(first.options) ? first.options : [];
    const labels = options.flatMap((option) => {
        const label = isObject(option) ? option.label : option;
        return typeof label === "string" && label.trim() ? [label.trim()] : [];
    });

    return labels.length > 0 ? labels : undefined;
}

/** A question call of the given kind, with the options its input lists. */
export function questionCallOf(kind: TurnQuestionKind, callId: string, input: unknown): TurnQuestionCall {
    const options = questionOptionsOf(input);
    const questionCount = questionCountOf(input);
    return { kind, callId, ...(options ? { options } : {}), ...(questionCount ? { questionCount } : {}) };
}

/** Input keys that say what a call does, best first: a Bash `description` reads better than its command. */
const SUMMARY_KEYS = [
    "description",
    "command",
    "cmd",
    "file_path",
    "target_file",
    "path",
    "pattern",
    "query",
    "url",
    "skill",
    "prompt",
];

const SUMMARY_CHARS = 160;

export function firstLine(text: string): string {
    const line =
        text
            .split("\n")
            .map((part) => part.trim())
            .find(Boolean) ?? "";

    return line.length > SUMMARY_CHARS ? `${line.slice(0, SUMMARY_CHARS - 1)}…` : line;
}

/** One line from a tool call's input (an object, or its JSON text): the first of `SUMMARY_KEYS` it holds. */
export function toolSummaryOf(input: unknown): string {
    const value = typeof input === "string" ? parseTranscriptLine(input) : input;

    if (value === null) {
        return typeof input === "string" ? firstLine(input) : "";
    }

    if (!isObject(value)) {
        return "";
    }

    for (const key of SUMMARY_KEYS) {
        const field = value[key];

        if (typeof field === "string" && field.trim()) {
            return firstLine(field);
        }

        // Codex writes a command as argv, `["/bin/zsh", "-lc", "git status"]`: the last word is the command.
        const lastWord: unknown = Array.isArray(field) ? field.at(-1) : undefined;

        if (typeof lastWord === "string" && lastWord.trim()) {
            return firstLine(lastWord);
        }
    }

    return "";
}

/** A blocking question still open: the session waits on the user, so the last event becomes a question. */
export function waitingOn(events: ActivityEvent[]): ActivityEvent[] {
    const last = events.at(-1);
    return last ? [...events.slice(0, -1), { ...last, kind: "question" as const }] : events;
}

export function snapshotOf({
    input,
    events,
    lastText,
    asksQuestion,
    question = null,
    questionCall = null,
    endedTurn,
    interrupted = false,
    turnError = null,
    turnStartedAt,
    turnStartOffset,
    calls,
}: {
    input: TurnStateInput;
    events: ActivityEvent[];
    lastText: string;
    asksQuestion: boolean;
    question?: string | null;
    questionCall?: TurnQuestionCall | null;
    endedTurn: boolean;
    interrupted?: boolean;
    turnError?: string | null;
    turnStartedAt: number | null;
    turnStartOffset?: number;
    calls: TurnCalls;
}): TurnSnapshot {
    const lastEventAt = events.at(-1)?.ts ?? null;
    const lastActivityAt = Math.max(lastEventAt ?? 0, input.lastModified);
    // A closed transcript has no process behind it: the session is over, and nobody waits at its prompt any more.
    const state: ActivityState = input.closed
        ? "FINISHED"
        : classifyActivity({
              events,
              lastModified: input.lastModified,
              now: input.now,
              stallTimeoutMs: input.stallTimeoutMs,
          });

    return {
        // A turn that ended is never a stall, however long the session then sits at its prompt.
        state: endedTurn && state === "STALLED" ? "AWAITING-INPUT" : state,
        lastText,
        asksQuestion,
        question,
        ...(asksQuestion && questionCall ? { questionCall } : {}),
        interrupted,
        turnError,
        lastEventAt,
        ...(events.length > 0 ? { earliestTailEventAt: Math.min(...events.map((event) => event.ts)) } : {}),
        turnStartedAt,
        ...(turnStartOffset !== undefined ? { turnStartOffset } : {}),
        lastActivityAt,
        silenceMs: input.now - lastActivityAt,
        // A turn that ended leaves no call running, whatever result the tail is missing.
        openTools: endedTurn && !asksQuestion ? [] : [...calls.open.values()],
        handedBackAt: calls.handedBackAt,
    };
}

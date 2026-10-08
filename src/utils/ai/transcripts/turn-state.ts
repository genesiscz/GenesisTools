/**
 * Where a coding-agent session is in its CURRENT turn, read from its native transcript.
 *
 * `activity.ts` decides a state from events; this file turns three transcript dialects into those
 * events, and adds what a waiter needs beyond the state: the text of the last assistant message and a
 * marker that moves when a turn ends, so "wait for the next turn" can tell a new finish from an old one.
 *
 * - Claude: `<project>/<id>.jsonl`. The last conversation record decides (`activity.ts`).
 * - Grok:   `updates.jsonl` of a TUI session. `turn_completed` ends a turn; `hook_*` records are noise.
 * - Codex:  `rollout-*.jsonl`. `task_complete` (with `last_agent_message`) ends a turn.
 *
 * The readers are pure over parsed records. `readTurnState` is the one place that touches the disk:
 * one `stat`, one bounded tail read, no process spawn and no write.
 */
import { statSync } from "node:fs";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { type ActivityEvent, type ActivityState, classifyActivity, claudeRecordsToEvents } from "./activity";
import { readTail } from "./native-scan";
import { parseTranscriptLine } from "./parse-line";

export type TurnProvider = "claude" | "grok" | "codex";

/** A turn's last records can hold a long tool result, so this is larger than the activity tail. */
export const TURN_TAIL_BYTES = 256 * 1024;

type JsonRecord = Record<string, unknown>;

export interface TurnSnapshot {
    state: ActivityState;
    /** The text of the last assistant message. Empty when the tail holds none. */
    lastText: string;
    /**
     * True when the session waits on a question for the user: the turn ended on one (Claude `AskUserQuestion`,
     * Codex `request_user_input_async`), or a blocking question tool has no answer yet (Codex
     * `request_user_input`, Grok `ask_user_question` or `exit_plan`). Decided from the tool calls, never from
     * the wording of the message.
     */
    asksQuestion: boolean;
    /**
     * The text of the newest question tool call in the current turn, answered or not. A Codex
     * `request_user_input_async` asked while the turn keeps running shows up here with `asksQuestion` false.
     */
    question: string | null;
    /** True when the user stopped the turn (Esc in Claude, `turn_aborted` in Codex). The turn has ended. */
    interrupted: boolean;
    /** Epoch ms of the newest turn-level record. Null when the tail holds none. Grows when a turn ends. */
    lastEventAt: number | null;
    /**
     * Epoch ms of the record that opened the newest turn: Claude's user prompt, Codex `task_started`, Grok's first
     * `user_message_chunk`. Null when the tail holds none (the turn began before it). `message --wait` uses it to
     * tell the turn that answers its message from one that was already running when the message was queued.
     */
    turnStartedAt: number | null;
    /** The newer of `lastEventAt` and the file's modification time. */
    lastActivityAt: number;
    /** `now` minus `lastActivityAt`. */
    silenceMs: number;
}

export interface TurnStateInput {
    /** Parsed transcript records, oldest first. */
    records: ReadonlyArray<JsonRecord>;
    /** The file's modification time in epoch ms. */
    lastModified: number;
    now: number;
    /** Silence longer than this is a stall. `Number.POSITIVE_INFINITY` never stalls. */
    stallTimeoutMs: number;
}

function isRecord(value: unknown): value is JsonRecord {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toEpochMs(value: unknown): number | undefined {
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

/** The first question in a question tool's input: `questions[0].question`, else its `title` or `header`. */
function questionTextOf(input: unknown): string | null {
    let value = input;

    if (typeof input === "string") {
        try {
            value = SafeJSON.parse(input, { strict: true });
        } catch (err) {
            logger.debug({ err }, "[transcripts] question tool arguments are not JSON; using them as the text");
            return input.trim() || null;
        }
    }

    const first = isRecord(value) && Array.isArray(value.questions) ? value.questions[0] : undefined;

    if (!isRecord(first)) {
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

/** A blocking question still open: the session waits on the user, so the last event becomes a question. */
function waitingOn(events: ActivityEvent[]): ActivityEvent[] {
    const last = events.at(-1);
    return last ? [...events.slice(0, -1), { ...last, kind: "question" as const }] : events;
}

function snapshotOf({
    input,
    events,
    lastText,
    asksQuestion,
    question = null,
    endedTurn,
    interrupted = false,
    turnStartedAt,
}: {
    input: TurnStateInput;
    events: ActivityEvent[];
    lastText: string;
    asksQuestion: boolean;
    question?: string | null;
    endedTurn: boolean;
    interrupted?: boolean;
    turnStartedAt: number | null;
}): TurnSnapshot {
    const lastEventAt = events.at(-1)?.ts ?? null;
    const lastActivityAt = Math.max(lastEventAt ?? 0, input.lastModified);
    const state = classifyActivity({
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
        interrupted,
        lastEventAt,
        turnStartedAt,
        lastActivityAt,
        silenceMs: input.now - lastActivityAt,
    };
}

const CLAUDE_CONVERSATION: ReadonlySet<string> = new Set(["assistant", "user", "result"]);

function claudeTextBlocks(record: JsonRecord): string[] {
    const message = isRecord(record.message) ? record.message : null;
    const content = message?.content;

    if (typeof content === "string") {
        return [content];
    }

    if (!Array.isArray(content)) {
        return [];
    }

    return content.flatMap((block) =>
        isRecord(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : []
    );
}

/** The question of an `AskUserQuestion` call in this record, `""` when it has no readable text, else null. */
function claudeQuestionOf(record: JsonRecord): string | null {
    const message = isRecord(record.message) ? record.message : null;
    const content = message?.content;

    if (!Array.isArray(content)) {
        return null;
    }

    const call = content.find(
        (block) => isRecord(block) && block.type === "tool_use" && block.name === "AskUserQuestion"
    );
    return isRecord(call) ? (questionTextOf(call.input) ?? "") : null;
}

/**
 * Claude writes one record per content block, all with the same `message.id`. The final message is
 * therefore the run of assistant records at the end that share the id of the last one.
 */
function claudeFinalMessage(records: ReadonlyArray<JsonRecord>): {
    text: string;
    asksQuestion: boolean;
    question: string | null;
} {
    const lastConversation = records.findLastIndex(
        (record) => typeof record.type === "string" && CLAUDE_CONVERSATION.has(record.type)
    );
    const last = records[lastConversation];

    if (!last) {
        return { text: "", asksQuestion: false, question: null };
    }

    if (last.type === "result") {
        return { text: typeof last.result === "string" ? last.result : "", asksQuestion: false, question: null };
    }

    const lastMessage = isRecord(last.message) ? last.message : null;
    const messageId = typeof lastMessage?.id === "string" ? lastMessage.id : null;
    const texts: string[] = [];
    let question: string | null = null;

    for (let index = lastConversation; index >= 0; index--) {
        const record = records[index];

        if (record.type !== "assistant") {
            if (record.type === "user" || record.type === "result") {
                break;
            }

            continue;
        }

        const message = isRecord(record.message) ? record.message : null;

        if (messageId !== null && message?.id !== messageId) {
            break;
        }

        texts.unshift(...claudeTextBlocks(record));
        question = question ?? claudeQuestionOf(record);

        if (messageId === null) {
            break;
        }
    }

    return { text: texts.join("\n").trim(), asksQuestion: question !== null, question: question || null };
}

/**
 * Esc writes a user record `[Request interrupted by user]` (or `… for tool use]`) and the session is
 * back at its prompt. Without this the turn reads as running, and as a stall after the limit.
 */
function claudeInterrupted(records: ReadonlyArray<JsonRecord>): boolean {
    const last = records.findLast((record) => typeof record.type === "string" && CLAUDE_CONVERSATION.has(record.type));

    if (last?.type !== "user") {
        return false;
    }

    const message = isRecord(last.message) ? last.message : null;
    const content = message?.content;
    const texts = typeof content === "string" ? [content] : claudeTextBlocks(last);

    return texts.some((text) => text.startsWith("[Request interrupted by user"));
}

/**
 * When the newest Claude turn began: the newest user record that is a prompt, not a tool result, a meta record or
 * an interrupt note.
 */
function claudeTurnStartedAt(records: ReadonlyArray<JsonRecord>): number | null {
    for (let index = records.length - 1; index >= 0; index--) {
        const record = records[index];

        if (record.type !== "user" || record.isMeta === true) {
            continue;
        }

        const content = isRecord(record.message) ? record.message.content : undefined;
        const texts = claudeTextBlocks(record);
        const prompt = typeof content === "string" || texts.length > 0;

        if (prompt && !texts.some((text) => text.startsWith("[Request interrupted by user"))) {
            return toEpochMs(record.timestamp) ?? null;
        }
    }

    return null;
}

export function claudeTurnState(input: TurnStateInput): TurnSnapshot {
    const interrupted = claudeInterrupted(input.records);
    const raw = claudeRecordsToEvents(input.records);
    const last = raw.at(-1);
    // An interrupt ends the turn the way a question does: the session waits for the user.
    const events = interrupted && last ? [...raw.slice(0, -1), { ...last, kind: "question" as const }] : raw;
    const final = claudeFinalMessage(input.records);

    return snapshotOf({
        input,
        events,
        lastText: final.text,
        asksQuestion: final.asksQuestion && last?.kind === "question",
        question: final.question,
        endedTurn: interrupted || last?.kind === "question" || last?.kind === "exit",
        interrupted,
        turnStartedAt: claudeTurnStartedAt(input.records),
    });
}

/** What a Grok `updates.jsonl` line says, or null when it is not an update line. */
function grokUpdateOf(record: JsonRecord): { kind: string; update: JsonRecord; ts: number | undefined } | null {
    const params = isRecord(record.params) ? record.params : null;
    const update = params && isRecord(params.update) ? params.update : null;
    const kind = update?.sessionUpdate;

    if (!update || typeof kind !== "string") {
        return null;
    }

    return { kind, update, ts: toEpochMs(record.timestamp) };
}

function grokText(content: unknown): string {
    if (isRecord(content) && content.type === "text" && typeof content.text === "string") {
        return content.text;
    }

    return typeof content === "string" ? content : "";
}

/** Updates that mean the agent is doing something. `hook_*` records fire after a turn ends too. */
const GROK_WORK: ReadonlySet<string> = new Set([
    "user_message_chunk",
    "agent_message_chunk",
    "agent_thought_chunk",
    "tool_call",
    "tool_call_update",
    "plan",
    "turn_completed",
]);

/** Grok tools that stop the turn until the user answers: a question, and a plan to approve. */
const GROK_WAITING_TOOLS: ReadonlySet<string> = new Set(["ask_user", "exit_plan"]);

function grokToolKind(update: JsonRecord): string | null {
    const meta = isRecord(update._meta) ? update._meta : null;
    const tool = meta && isRecord(meta["x.ai/tool"]) ? meta["x.ai/tool"] : null;
    return typeof tool?.kind === "string" ? tool.kind : null;
}

export function grokTurnState(input: TurnStateInput): TurnSnapshot {
    const events: ActivityEvent[] = [];
    let message = "";
    let ended = false;
    let question: string | null = null;
    let turnStartedAt: number | null = null;
    let previousKind: string | null = null;
    // toolCallId → question text, until a `tool_call_update` with a status answers it.
    const open = new Map<string, string>();

    for (const record of input.records) {
        const parsed = grokUpdateOf(record);

        if (!parsed || !GROK_WORK.has(parsed.kind) || parsed.ts === undefined) {
            continue;
        }

        // A prompt arrives as several chunks: the first one opens the turn.
        if (parsed.kind === "user_message_chunk" && previousKind !== "user_message_chunk") {
            turnStartedAt = parsed.ts;
        }

        previousKind = parsed.kind;

        ended = parsed.kind === "turn_completed";
        events.push({ ts: parsed.ts, kind: ended ? "question" : "output" });
        const callId = typeof parsed.update.toolCallId === "string" ? parsed.update.toolCallId : null;

        if (parsed.kind === "agent_message_chunk") {
            message += grokText(parsed.update.content);
        } else if (parsed.kind === "tool_call" || parsed.kind === "user_message_chunk") {
            message = "";
        }

        if (parsed.kind === "user_message_chunk") {
            question = null;
        }

        const toolKind = grokToolKind(parsed.update);

        if (parsed.kind === "tool_call" && callId && toolKind && GROK_WAITING_TOOLS.has(toolKind)) {
            question = questionTextOf(parsed.update.rawInput) ?? (toolKind === "exit_plan" ? "Approve the plan?" : "");
            open.set(callId, question);
        } else if (parsed.kind === "tool_call_update" && callId && typeof parsed.update.status === "string") {
            open.delete(callId);
        }
    }

    const waiting = open.size > 0;

    return snapshotOf({
        input,
        events: waiting ? waitingOn(events) : events,
        lastText: message.trim(),
        asksQuestion: waiting,
        question: question || null,
        endedTurn: ended || waiting,
        turnStartedAt,
    });
}

function codexPayloadOf(record: JsonRecord): { type: string; payload: JsonRecord } | null {
    const payload = isRecord(record.payload) ? record.payload : null;
    const type = payload?.type;

    return payload && typeof type === "string" ? { type, payload } : null;
}

/** `event_msg` payloads of a turn at work: its start, the user's prompt and the agent's output. */
const CODEX_TURN_EVENTS = new Set([
    "task_started",
    "user_message",
    "agent_message",
    "agent_reasoning",
    "item_completed",
]);

/** A record that starts or advances a turn: a model item (`response_item`) or a turn event. */
function codexAdvancesTurn(record: JsonRecord, payloadType: string): boolean {
    return record.type === "response_item" || (record.type === "event_msg" && CODEX_TURN_EVENTS.has(payloadType));
}

export function codexTurnState(input: TurnStateInput): TurnSnapshot {
    const events: ActivityEvent[] = [];
    let message = "";
    let ended = false;
    let aborted = false;
    let question: string | null = null;
    // call_id → question text of a `request_user_input` with no `function_call_output` yet.
    const open = new Map<string, string>();
    // The turn's last tool call was `request_user_input_async`: the turn ends on that question.
    let lastCallAsks = false;
    let turnStartedAt: number | null = null;

    for (const record of input.records) {
        const ts = toEpochMs(record.timestamp);
        const parsed = codexPayloadOf(record);

        if (ts === undefined || !parsed) {
            continue;
        }

        if (record.type === "event_msg" && (parsed.type === "task_complete" || parsed.type === "turn_aborted")) {
            ended = true;
            aborted = parsed.type === "turn_aborted";
            events.push({ ts, kind: "question" });

            if (typeof parsed.payload.last_agent_message === "string") {
                message = parsed.payload.last_agent_message;
            }

            continue;
        }

        // Bookkeeping that follows a finished turn (token counts, thread settings) must not reopen it: only a
        // record that starts or advances a turn does.
        if (ended && !codexAdvancesTurn(record, parsed.type)) {
            continue;
        }

        if (
            record.type === "event_msg" &&
            parsed.type === "agent_message" &&
            typeof parsed.payload.message === "string"
        ) {
            message = parsed.payload.message;
        }

        if (record.type === "event_msg" && parsed.type === "task_started") {
            turnStartedAt = ts;
            message = "";
            question = null;
            lastCallAsks = false;
            open.clear();
        }

        const callId = typeof parsed.payload.call_id === "string" ? parsed.payload.call_id : null;

        if (record.type === "response_item" && parsed.type === "function_call") {
            const name = parsed.payload.name;
            lastCallAsks = name === "request_user_input_async";

            if (name === "request_user_input" || name === "request_user_input_async") {
                question = questionTextOf(parsed.payload.arguments) ?? "";

                if (name === "request_user_input" && callId) {
                    open.set(callId, question);
                }
            }
        } else if (record.type === "response_item" && parsed.type === "function_call_output" && callId) {
            open.delete(callId);
        }

        ended = false;
        aborted = false;
        events.push({ ts, kind: "output" });
    }

    const waiting = !ended && open.size > 0;

    return snapshotOf({
        input,
        events: waiting ? waitingOn(events) : events,
        lastText: message.trim(),
        asksQuestion: waiting || (ended && !aborted && lastCallAsks),
        question: question || null,
        endedTurn: ended || waiting,
        interrupted: aborted,
        turnStartedAt,
    });
}

const READERS: Record<TurnProvider, (input: TurnStateInput) => TurnSnapshot> = {
    claude: claudeTurnState,
    grok: grokTurnState,
    codex: codexTurnState,
};

export function isTurnProvider(value: string): value is TurnProvider {
    return value in READERS;
}

export function turnStateOf(provider: TurnProvider, input: TurnStateInput): TurnSnapshot {
    return READERS[provider](input);
}

export interface ReadTurnStateOptions {
    now?: number;
    stallTimeoutMs: number;
}

/**
 * The turn state of one native transcript file, or null for a file that is empty or cannot be read.
 *
 * A last record longer than `TURN_TAIL_BYTES` leaves no whole record in the tail. The state then comes
 * from the modification time alone: `RUNNING` or `STALLED`, never a finish.
 */
export function readTurnState(
    provider: TurnProvider,
    filePath: string,
    options: ReadTurnStateOptions
): TurnSnapshot | null {
    const now = options.now ?? Date.now();

    try {
        const stat = statSync(filePath);

        if (stat.size === 0) {
            return null;
        }

        const records = readTail(filePath, TURN_TAIL_BYTES)
            .split("\n")
            .map((line) => parseTranscriptLine(line))
            .filter((record): record is JsonRecord => record !== null);

        return turnStateOf(provider, {
            records,
            lastModified: stat.mtimeMs,
            now,
            stallTimeoutMs: options.stallTimeoutMs,
        });
    } catch (err) {
        logger.debug({ err, filePath, provider }, "[transcripts] could not read the turn state of a transcript");
        return null;
    }
}

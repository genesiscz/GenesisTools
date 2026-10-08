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
    /** True when the turn ended on a question for the user (Claude `AskUserQuestion`). */
    asksQuestion: boolean;
    /** True when the user stopped the turn (Esc in Claude, `turn_aborted` in Codex). The turn has ended. */
    interrupted: boolean;
    /** Epoch ms of the newest turn-level record. Null when the tail holds none. Grows when a turn ends. */
    lastEventAt: number | null;
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

function snapshotOf({
    input,
    events,
    lastText,
    asksQuestion,
    endedTurn,
    interrupted = false,
}: {
    input: TurnStateInput;
    events: ActivityEvent[];
    lastText: string;
    asksQuestion: boolean;
    endedTurn: boolean;
    interrupted?: boolean;
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
        interrupted,
        lastEventAt,
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

function claudeAsksQuestion(record: JsonRecord): boolean {
    const message = isRecord(record.message) ? record.message : null;
    const content = message?.content;

    return (
        Array.isArray(content) &&
        content.some((block) => isRecord(block) && block.type === "tool_use" && block.name === "AskUserQuestion")
    );
}

/**
 * Claude writes one record per content block, all with the same `message.id`. The final message is
 * therefore the run of assistant records at the end that share the id of the last one.
 */
function claudeFinalMessage(records: ReadonlyArray<JsonRecord>): { text: string; asksQuestion: boolean } {
    const lastConversation = records.findLastIndex(
        (record) => typeof record.type === "string" && CLAUDE_CONVERSATION.has(record.type)
    );
    const last = records[lastConversation];

    if (!last) {
        return { text: "", asksQuestion: false };
    }

    if (last.type === "result") {
        return { text: typeof last.result === "string" ? last.result : "", asksQuestion: false };
    }

    const lastMessage = isRecord(last.message) ? last.message : null;
    const messageId = typeof lastMessage?.id === "string" ? lastMessage.id : null;
    const texts: string[] = [];
    let asksQuestion = false;

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
        asksQuestion = asksQuestion || claudeAsksQuestion(record);

        if (messageId === null) {
            break;
        }
    }

    return { text: texts.join("\n").trim(), asksQuestion };
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
        endedTurn: interrupted || last?.kind === "question" || last?.kind === "exit",
        interrupted,
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

export function grokTurnState(input: TurnStateInput): TurnSnapshot {
    const events: ActivityEvent[] = [];
    let message = "";
    let ended = false;

    for (const record of input.records) {
        const parsed = grokUpdateOf(record);

        if (!parsed || !GROK_WORK.has(parsed.kind) || parsed.ts === undefined) {
            continue;
        }

        ended = parsed.kind === "turn_completed";
        events.push({ ts: parsed.ts, kind: ended ? "question" : "output" });

        if (parsed.kind === "agent_message_chunk") {
            message += grokText(parsed.update.content);
        } else if (parsed.kind === "tool_call" || parsed.kind === "user_message_chunk") {
            message = "";
        }
    }

    return snapshotOf({ input, events, lastText: message.trim(), asksQuestion: false, endedTurn: ended });
}

function codexPayloadOf(record: JsonRecord): { type: string; payload: JsonRecord } | null {
    const payload = isRecord(record.payload) ? record.payload : null;
    const type = payload?.type;

    return payload && typeof type === "string" ? { type, payload } : null;
}

export function codexTurnState(input: TurnStateInput): TurnSnapshot {
    const events: ActivityEvent[] = [];
    let message = "";
    let ended = false;
    let aborted = false;

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

        // Bookkeeping that follows a finished turn (token counts) must not reopen it.
        if (ended && (parsed.type === "token_count" || record.type === "token_usage_record")) {
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
            message = "";
        }

        ended = false;
        aborted = false;
        events.push({ ts, kind: "output" });
    }

    return snapshotOf({
        input,
        events,
        lastText: message.trim(),
        asksQuestion: false,
        endedTurn: ended,
        interrupted: aborted,
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

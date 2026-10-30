/** The Grok driver's `turnState` part: the newest turn of an `updates.jsonl`, plus the prompts of `events.jsonl`. */
import type { NativeDialogPermission } from "@genesiscz/utils/agent-sessions/types";
import type { ActivityEvent } from "@genesiscz/utils/ai/transcripts/activity";
import type {
    JsonRecord,
    TurnQuestionCall,
    TurnQuestionKind,
    TurnSnapshot,
    TurnStateInput,
} from "@genesiscz/utils/ai/transcripts/turn-state";
import {
    firstLine,
    isRecord,
    questionCallOf,
    questionTextOf,
    snapshotOf,
    TurnCalls,
    toEpochMs,
    toolSummaryOf,
    waitingOn,
} from "@genesiscz/utils/ai/transcripts/turn-state-core";

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

/** Grok tool-call statuses that end a call. `in_progress` and `pending` are progress, not an answer. */
const GROK_TERMINAL_STATUSES: ReadonlySet<string> = new Set(["completed", "failed"]);

/** Grok tools that stop the turn until the user answers, by `_meta["x.ai/tool"].kind`: a question, a plan to approve. */
const GROK_WAITING_TOOLS: ReadonlyMap<string, TurnQuestionKind> = new Map([
    ["ask_user", "decision"],
    ["exit_plan", "plan"],
]);

/**
 * The open permission prompt as a question: the tool and a summary of its input, from the newest open `tool_call` of
 * that tool in `updates.jsonl` (Grok writes the call before the prompt and its result only after the answer), and that
 * call's id. A request with no open call of its tool counts only while it is newer than the transcript's last record,
 * with the id `permission:<request time>`; an older one belongs to a call the transcript already finished.
 */
function grokPermissionQuestion(
    request: NativeDialogPermission,
    calls: TurnCalls,
    lastEventAt: number | null
): { question: string; call: TurnQuestionCall } | null {
    const call = [...calls.open.values()].filter((open) => open.name === request.tool).at(-1);

    if (call) {
        return {
            question: call.summary ? `${call.name}: ${call.summary}` : call.name,
            call: { kind: "permission", callId: call.id },
        };
    }

    const requestedAt = toEpochMs(request.at);

    // Grok stamps `updates.jsonl` in whole seconds, so a request in the same second as the last record is newer.
    if (requestedAt === undefined || (lastEventAt !== null && requestedAt < lastEventAt)) {
        return null;
    }

    return { question: request.tool, call: { kind: "permission", callId: `permission:${request.at}` } };
}

function grokToolMeta(update: JsonRecord): JsonRecord | null {
    const meta = isRecord(update._meta) ? update._meta : null;
    return meta && isRecord(meta["x.ai/tool"]) ? meta["x.ai/tool"] : null;
}

function grokToolKind(update: JsonRecord): string | null {
    const tool = grokToolMeta(update);
    return typeof tool?.kind === "string" ? tool.kind : null;
}

/** `run_terminal_command`, `read_file`: the tool's own name, else the call's title. */
function grokToolName(update: JsonRecord): string {
    const name = grokToolMeta(update)?.name;

    if (typeof name === "string" && name) {
        return name;
    }

    return typeof update.title === "string" && update.title ? update.title : "tool";
}

/** The call's input as one line, else its title ("Execute `bun test`"). */
function grokToolSummary(update: JsonRecord): string {
    return toolSummaryOf(update.rawInput) || (typeof update.title === "string" ? firstLine(update.title) : "");
}

export function grokTurnState(input: TurnStateInput): TurnSnapshot {
    const events: ActivityEvent[] = [];
    let message = "";
    let ended = false;
    let question: string | null = null;
    let turnStartedAt: number | null = null;
    let turnStartOffset: number | undefined;
    let previousKind: string | null = null;
    // toolCallId → the question tool's call, until a `tool_call_update` with a terminal status answers it.
    const open = new Map<string, TurnQuestionCall>();
    // Every call of the turn still running, closed the same way.
    const calls = new TurnCalls();

    for (const [index, record] of input.records.entries()) {
        const parsed = grokUpdateOf(record);

        if (!parsed || !GROK_WORK.has(parsed.kind) || parsed.ts === undefined) {
            continue;
        }

        // A prompt arrives as several chunks: the first one opens the turn.
        if (parsed.kind === "user_message_chunk" && previousKind !== "user_message_chunk") {
            turnStartedAt = parsed.ts;
            turnStartOffset = input.offsets?.[index];
            // A new prompt starts another turn: a question the last one left open is not this turn's to wait on.
            open.clear();
            calls.start(parsed.ts);
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
        const waitingKind = toolKind ? GROK_WAITING_TOOLS.get(toolKind) : undefined;

        if (parsed.kind === "tool_call" && callId && waitingKind) {
            question = questionTextOf(parsed.update.rawInput) ?? (waitingKind === "plan" ? "Approve the plan?" : "");
            open.set(callId, questionCallOf(waitingKind, callId, parsed.update.rawInput));
        } else if (
            parsed.kind === "tool_call_update" &&
            callId &&
            typeof parsed.update.status === "string" &&
            GROK_TERMINAL_STATUSES.has(parsed.update.status)
        ) {
            open.delete(callId);
        }

        if (parsed.kind === "turn_completed") {
            calls.end();
        } else if (parsed.kind === "tool_call" && callId) {
            const name = grokToolName(parsed.update);
            const summary = grokToolSummary(parsed.update);
            // The first record's title is the tool's name; a later update brings "Execute `…`".
            calls.call({ id: callId, name, summary: summary === name ? "" : summary, startedAt: parsed.ts });
        } else if (parsed.kind === "tool_call_update" && callId) {
            const call = calls.open.get(callId);

            if (typeof parsed.update.status === "string" && GROK_TERMINAL_STATUSES.has(parsed.update.status)) {
                calls.result(callId, parsed.ts);
            } else if (call && !call.summary) {
                call.summary = grokToolSummary(parsed.update);
            }
        }
    }

    const asked = [...open.values()].at(-1) ?? null;
    // A question tool waits on its own; a permission prompt only while the turn is still running.
    const request = !asked && !ended ? input.permission : null;
    const permission = request ? grokPermissionQuestion(request, calls, events.at(-1)?.ts ?? null) : null;
    const waiting = asked !== null || permission !== null;

    return snapshotOf({
        input,
        events: waiting ? waitingOn(events) : events,
        lastText: message.trim(),
        asksQuestion: waiting,
        question: permission ? permission.question : question || null,
        questionCall: permission ? permission.call : asked,
        endedTurn: ended || waiting,
        turnStartedAt,
        turnStartOffset,
        calls,
    });
}

/** The Codex driver's `turnState` part: the newest turn of a `rollout-*.jsonl`. */
import type { ActivityEvent } from "@genesiscz/utils/ai/transcripts/activity";
import type {
    JsonRecord,
    TurnQuestionCall,
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
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

/** A Codex `exec` script calls `tools.exec_command({cmd: "…"})`: the command, else the tool it calls, else its first line. */
function codexScriptSummary(script: string): string {
    const command = /\bcmd\s*:\s*("(?:[^"\\]|\\.)*")/.exec(script)?.[1];

    if (command) {
        try {
            const text = SafeJSON.parse(command, { strict: true });

            if (typeof text === "string") {
                return firstLine(text);
            }
        } catch (err) {
            logger.debug({ err }, "[transcripts] a codex exec command is not a JSON string; using the script");
        }
    }

    return /\btools\.(\w+)\(/.exec(script)?.[1] ?? firstLine(script);
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
    let turnError: string | null = null;
    let question: string | null = null;
    // The newest `request_user_input(_async)` call of the turn, with its id and options.
    let questionCall: TurnQuestionCall | null = null;
    // call_id → the `request_user_input` call with no `function_call_output` yet.
    const open = new Map<string, TurnQuestionCall>();
    // The turn's last tool call was `request_user_input_async`: the turn ends on that question.
    let lastCallAsks = false;
    let turnStartedAt: number | null = null;
    // Every call of the turn with no `*_output` yet.
    const calls = new TurnCalls();

    for (const record of input.records) {
        const ts = toEpochMs(record.timestamp);
        const parsed = codexPayloadOf(record);

        if (ts === undefined || !parsed) {
            continue;
        }

        if (record.type === "event_msg" && (parsed.type === "task_complete" || parsed.type === "turn_aborted")) {
            ended = true;
            aborted = parsed.type === "turn_aborted";
            // 2026-10-14: a worker whose remote compaction failed ended every turn at once with this error, and
            // `tools codex wait` reported each one as done.
            const failure = parsed.payload.error;
            turnError = isRecord(failure) && typeof failure.message === "string" ? failure.message : null;
            calls.end();
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
            questionCall = null;
            lastCallAsks = false;
            open.clear();
            calls.start(ts);
        }

        const callId = typeof parsed.payload.call_id === "string" ? parsed.payload.call_id : null;

        if (record.type === "response_item" && callId) {
            if (parsed.type === "function_call" || parsed.type === "custom_tool_call") {
                const name = typeof parsed.payload.name === "string" ? parsed.payload.name : "tool";
                const script = typeof parsed.payload.input === "string" ? parsed.payload.input : "";
                const summary =
                    parsed.type === "custom_tool_call"
                        ? codexScriptSummary(script)
                        : toolSummaryOf(parsed.payload.arguments);
                calls.call({ id: callId, name, summary, startedAt: ts });
            } else if (parsed.type === "function_call_output" || parsed.type === "custom_tool_call_output") {
                calls.result(callId, ts);
            }
        }

        if (record.type === "response_item" && parsed.type === "function_call") {
            const name = parsed.payload.name;
            lastCallAsks = name === "request_user_input_async";

            if (name === "request_user_input" || name === "request_user_input_async") {
                question = questionTextOf(parsed.payload.arguments) ?? "";
                questionCall = callId ? questionCallOf("decision", callId, parsed.payload.arguments) : null;

                if (name === "request_user_input" && questionCall) {
                    open.set(questionCall.callId, questionCall);
                }
            }
        } else if (record.type === "response_item" && parsed.type === "function_call_output" && callId) {
            open.delete(callId);
        }

        ended = false;
        aborted = false;
        turnError = null;
        events.push({ ts, kind: "output" });
    }

    const waiting = !ended && open.size > 0;

    return snapshotOf({
        input,
        events: waiting ? waitingOn(events) : events,
        lastText: message.trim(),
        asksQuestion: waiting || (ended && !aborted && lastCallAsks),
        question: question || null,
        questionCall: waiting ? [...open.values()].at(-1) : questionCall,
        endedTurn: ended || waiting,
        interrupted: aborted,
        turnError: ended ? turnError : null,
        turnStartedAt,
        calls,
    });
}

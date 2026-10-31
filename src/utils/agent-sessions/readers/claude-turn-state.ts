/** The Claude driver's `turnState` part: the newest turn of a `<project>/<id>.jsonl` transcript. */
import type { ActivityEvent } from "@genesiscz/utils/ai/transcripts/activity";
import {
    questionCallOf,
    questionTextOf,
    snapshotOf,
    TurnCalls,
    toEpochMs,
    toolSummaryOf,
    waitingOn,
} from "@genesiscz/utils/ai/transcripts/turn-state-core";
import type {
    JsonRecord,
    OpenToolCall,
    TurnQuestionCall,
    TurnSnapshot,
    TurnStateInput,
} from "@genesiscz/utils/ai/transcripts/turn-state-types";
import { isObject } from "@genesiscz/utils/object";

/** The record types that say where a Claude session is. Everything else is bookkeeping. */
const CLAUDE_CONVERSATION: ReadonlySet<string> = new Set(["assistant", "user", "result"]);

/** The question tool: its call ends the turn on a question for the user. */
const CLAUDE_QUESTION_TOOL = "AskUserQuestion";

/** Claude tools that stop the turn until the user answers, and what they wait on. */
const CLAUDE_WAITING_TOOLS: Readonly<Record<string, NonNullable<OpenToolCall["waits"]>>> = {
    [CLAUDE_QUESTION_TOOL]: "decision",
    ExitPlanMode: "plan",
};

function asksUser(record: JsonRecord): boolean {
    if (record.type !== "assistant") {
        return false;
    }

    const message = isObject(record.message) ? record.message : null;
    const content = message?.content;

    if (
        Array.isArray(content) &&
        content.some((block) => isObject(block) && block.type === "tool_use" && block.name === CLAUDE_QUESTION_TOOL)
    ) {
        return true;
    }

    // A completed turn means the session sits at its prompt, waiting for the user.
    return message?.stop_reason === "end_turn";
}

/**
 * Claude transcript records, oldest first, as events.
 *
 * Only the LAST conversation record (`assistant`, `user` or `result`) can mark a finish or a question.
 * `summary` records sit at the top of compacted sessions and a `result` in the middle belongs to a
 * sub-agent, so treating either as terminal would freeze a live session at `FINISHED`.
 *
 * Records after the last conversation record are bookkeeping (`cost-state`, `system`, `queue-operation`).
 * Measured 2026-10-05: 39 of the 40 most recent transcripts on one machine ended on one of those, so a
 * rule that read the final line saw an end of turn almost never. They produce no event: pass the file's
 * modification time as `lastModified`, which already covers their time. A record without a timestamp
 * produces none.
 */
export function claudeRecordsToEvents(records: ReadonlyArray<JsonRecord>): ActivityEvent[] {
    const stamped = records.flatMap((record) => {
        const ts = toEpochMs(record.timestamp ?? record.ts);

        return ts === undefined ? [] : [{ record, ts }];
    });
    const lastConversation = stamped.findLastIndex(
        ({ record }) => typeof record.type === "string" && CLAUDE_CONVERSATION.has(record.type)
    );
    const upTo = lastConversation === -1 ? stamped.length : lastConversation + 1;

    return stamped.slice(0, upTo).map(({ record, ts }, index): ActivityEvent => {
        if (index === lastConversation && record.type === "result") {
            return { kind: "exit", ts };
        }

        if (index === lastConversation && asksUser(record)) {
            return { kind: "question", ts };
        }

        return { kind: "output", ts };
    });
}

function claudeTextBlocks(record: JsonRecord): string[] {
    const message = isObject(record.message) ? record.message : null;
    const content = message?.content;

    if (typeof content === "string") {
        return [content];
    }

    if (!Array.isArray(content)) {
        return [];
    }

    return content.flatMap((block) =>
        isObject(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : []
    );
}

/**
 * The `AskUserQuestion` call in this record, else null: its question (`""` when it has no readable text) and the call
 * with its `tool_use` id and options.
 */
function claudeQuestionOf(record: JsonRecord): { text: string; call: TurnQuestionCall | null } | null {
    const message = isObject(record.message) ? record.message : null;
    const content = message?.content;

    if (!Array.isArray(content)) {
        return null;
    }

    const call = content.find(
        (block) => isObject(block) && block.type === "tool_use" && block.name === CLAUDE_QUESTION_TOOL
    );
    if (!isObject(call)) {
        return null;
    }

    return {
        text: questionTextOf(call.input) ?? "",
        call: typeof call.id === "string" ? questionCallOf("decision", call.id, call.input) : null,
    };
}

/**
 * Claude writes one record per content block, all with the same `message.id`. The final message is
 * therefore the run of assistant records at the end that share the id of the last one.
 */
function claudeFinalMessage(records: ReadonlyArray<JsonRecord>): {
    text: string;
    asksQuestion: boolean;
    question: string | null;
    questionCall: TurnQuestionCall | null;
} {
    const lastConversation = records.findLastIndex(
        (record) => typeof record.type === "string" && CLAUDE_CONVERSATION.has(record.type)
    );
    const last = records[lastConversation];

    if (!last) {
        return { text: "", asksQuestion: false, question: null, questionCall: null };
    }

    if (last.type === "result") {
        return {
            text: typeof last.result === "string" ? last.result : "",
            asksQuestion: false,
            question: null,
            questionCall: null,
        };
    }

    const lastMessage = isObject(last.message) ? last.message : null;
    const messageId = typeof lastMessage?.id === "string" ? lastMessage.id : null;
    const texts: string[] = [];
    let question: { text: string; call: TurnQuestionCall | null } | null = null;

    for (let index = lastConversation; index >= 0; index--) {
        const record = records[index];

        if (record.type !== "assistant") {
            if (record.type === "user" || record.type === "result") {
                break;
            }

            continue;
        }

        const message = isObject(record.message) ? record.message : null;

        if (messageId !== null && message?.id !== messageId) {
            break;
        }

        texts.unshift(...claudeTextBlocks(record));
        question = question ?? claudeQuestionOf(record);

        if (messageId === null) {
            break;
        }
    }

    return {
        text: texts.join("\n").trim(),
        asksQuestion: question !== null,
        question: question?.text || null,
        questionCall: question?.call ?? null,
    };
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

    const message = isObject(last.message) ? last.message : null;
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

        const content = isObject(record.message) ? record.message.content : undefined;
        const texts = claudeTextBlocks(record);
        const prompt = typeof content === "string" || texts.length > 0;

        if (prompt && !texts.some((text) => text.startsWith("[Request interrupted by user"))) {
            return toEpochMs(record.timestamp) ?? null;
        }
    }

    return null;
}

/** A user record the person typed: no tool result in it, not a meta record. */
function claudeIsPrompt(record: JsonRecord): boolean {
    if (record.type !== "user" || record.isMeta === true) {
        return false;
    }

    const content = isObject(record.message) ? record.message.content : undefined;

    if (typeof content === "string") {
        return true;
    }

    return (
        Array.isArray(content) &&
        !content.some((block) => isObject(block) && block.type === "tool_result") &&
        claudeTextBlocks(record).length > 0
    );
}

/** `tool_use` blocks with no `tool_result` yet, since the newest prompt. */
function claudeCalls(records: ReadonlyArray<JsonRecord>): TurnCalls {
    const calls = new TurnCalls();

    for (const record of records) {
        const ts = toEpochMs(record.timestamp) ?? null;

        if (claudeIsPrompt(record)) {
            calls.start(ts);
            continue;
        }

        const content = isObject(record.message) ? record.message.content : undefined;

        if (!Array.isArray(content) || (record.type !== "assistant" && record.type !== "user")) {
            continue;
        }

        for (const block of content) {
            if (!isObject(block)) {
                continue;
            }

            if (record.type === "assistant" && block.type === "tool_use" && typeof block.id === "string") {
                const name = typeof block.name === "string" ? block.name : "tool";
                const waits = Object.hasOwn(CLAUDE_WAITING_TOOLS, name) ? CLAUDE_WAITING_TOOLS[name] : undefined;
                calls.call({
                    id: block.id,
                    name,
                    summary: toolSummaryOf(block.input),
                    startedAt: ts,
                    ...(waits ? { waits } : {}),
                });
            } else if (
                record.type === "user" &&
                block.type === "tool_result" &&
                typeof block.tool_use_id === "string"
            ) {
                calls.result(block.tool_use_id, ts);
            }
        }
    }

    return calls;
}

export function claudeTurnState(input: TurnStateInput): TurnSnapshot {
    const interrupted = claudeInterrupted(input.records);
    const raw = claudeRecordsToEvents(input.records);
    const last = raw.at(-1);
    // An interrupt ends the turn the way a question does: the session waits for the user.
    const events = interrupted ? waitingOn(raw) : raw;
    const final = claudeFinalMessage(input.records);

    return snapshotOf({
        input,
        events,
        lastText: final.text,
        asksQuestion: final.asksQuestion && last?.kind === "question",
        question: final.question,
        questionCall: final.questionCall,
        endedTurn: interrupted || last?.kind === "question" || last?.kind === "exit",
        interrupted,
        turnStartedAt: claudeTurnStartedAt(input.records),
        calls: claudeCalls(input.records),
    });
}

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { type AmbiguousAnswer, type ChatAnswer, chatAnswers } from "@app/question/lib/decisions/chat-answers";
import {
    decisionQuestion,
    mentionedDecisions,
    parseDecisionBlocks,
    questionNudgeVerdict,
    type SentDecisions,
    sendSessionDecisions,
    stopHookVerdict,
} from "@app/question/lib/decisions/read";
import {
    type DecisionRecord,
    harvestDecisions,
    kindOf,
    readDecisions,
    recordChatAnswers,
    recordDelivery,
} from "@app/question/lib/decisions/store";
import type { BackwardRead, ReadBackwardOptions } from "@genesiscz/utils/agent-sessions/types";
import { SafeJSON } from "@genesiscz/utils/json";
import type { DecisionsHookConfig } from "./config";
import { hookDiag } from "./log";
import type { HookPayload } from "./payload";
import { bumpContextCounts, readContextCounts, safeSessionId, setContextValues } from "./state";

/** The per-session counter the loop guard reads; it lives beside the guard's context counts. */
export const STOP_BLOCK_COUNTER = "decisions-stop-block";
/** The question nudge's own block counter, so it and the `❓ DECISION N` check do not spend each other's budget. */
export const NUDGE_BLOCK_COUNTER = "decisions-nudge-block";
/** The start (epoch ms) of the last turn the question nudge spoke in: it speaks once per turn. */
export const NUDGE_TURN_KEY = "decisions-nudge-turn";

/** When the chat-answer step last read the session (epoch ms): the next read stops there. */
export const CHAT_CHECKED_KEY = "decisions-chat-checked";
/** Prefix of the per-decision mark that the chat-answer step already sent the agent back about it. */
export const CHAT_SENT_BACK_PREFIX = "decisions-chat-sent-back:";
/** The most the chat-answer step reads back from a transcript's end, when no time bounds the read (Grok). */
const CHAT_READ_BYTES = 8 * 1024 * 1024;

/** How much of a transcript's end is read to find the last reply. A final reply is far smaller. */
const TAIL_BYTES = 512 * 1024;
/**
 * How much of a transcript's end is searched for the prompt that opened the turn. A long turn's tool output runs to
 * megabytes, and this read happens only for a reply that asks the user to decide.
 */
const PROMPT_TAIL_BYTES = 16 * 1024 * 1024;

export interface DecisionLogPaths {
    file: string;
    events: string;
}

/** The question nudge's per-session memory: its blocks so far and the last turn it spoke in. */
export interface NudgeState {
    blocks: (session: string) => number;
    lastTurn: (session: string) => number | undefined;
    record: (session: string, turn: number, blocked: boolean) => void;
}

/** The chat-answer step's per-session memory: when it last read, and which decisions it sent the agent back about. */
export interface ChatAnswerState {
    checkedAt: (session: string) => number | undefined;
    setCheckedAt: (session: string, at: number) => void;
    sentBack: (session: string, id: string) => boolean;
    markSentBack: (session: string, ids: string[]) => void;
}

/** A session's newest entries through its provider's reader (`readSessionBackward`). */
export type ReadSession = (
    options: ReadBackwardOptions & { kind: string; transcriptPath: string }
) => Promise<BackwardRead>;

export interface DecisionHookDeps {
    log: DecisionLogPaths;
    /**
     * Reads the session for the chat-answer step. Passed by the Stop entry only while `decisions.chatAnswers` is on,
     * so the provider registry loads only then; without it the step does nothing.
     */
    readSession?: ReadSession;
    /** The chat-answer step's state store; tests pass an in-memory one. */
    chat?: ChatAnswerState;
    now?: () => number;
    /** The loop guard's counter store; tests pass an in-memory one. */
    counts?: { read: (session: string) => number; bump: (session: string) => void };
    /** The question nudge's state store; tests pass an in-memory one. */
    nudge?: NudgeState;
    readTail?: (path: string) => string;
}

export type StopHookOutput = { decision: "block"; reason: string } | { systemMessage: string };

function str(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readTail(path: string, bytes = TAIL_BYTES): string {
    const fd = openSync(path, "r");

    try {
        const size = fstatSync(fd).size;
        const start = Math.max(0, size - bytes);
        const buffer = Buffer.alloc(size - start);
        readSync(fd, buffer, 0, buffer.length, start);
        return buffer.toString("utf8");
    } finally {
        closeSync(fd);
    }
}

/** The text of one transcript line when it is an assistant reply: Claude's `assistant` rows, Codex's `message` items. */
function assistantText(line: string): string | null {
    let row: unknown;

    try {
        row = SafeJSON.parse(line, { strict: true });
    } catch {
        // The first line of a tail read starts mid-row; any other torn line is equally not a reply.
        return null;
    }

    if (typeof row !== "object" || row === null) {
        return null;
    }

    const record = row as { type?: unknown; message?: unknown; payload?: unknown };
    const message = (record.type === "assistant" ? record.message : record.payload) as
        | { role?: unknown; type?: unknown; content?: unknown }
        | undefined;

    if (!message || (record.type !== "assistant" && message.role !== "assistant")) {
        return null;
    }

    const content = Array.isArray(message.content) ? message.content : [];
    const texts = content
        .map((block: { type?: unknown; text?: unknown }) =>
            block.type === "text" || block.type === "output_text" ? str(block.text) : undefined
        )
        .filter((text): text is string => Boolean(text));

    return texts.length > 0 ? texts.join("\n") : null;
}

/**
 * The reply this Stop is about. Codex (and newer Claude builds) hand it over as
 * `last_assistant_message`; otherwise it is the last assistant text in the transcript.
 */
export function finalReply(payload: HookPayload, read: (path: string) => string = readTail): string {
    const given = str(payload.raw.last_assistant_message) ?? str(payload.raw.lastAssistantMessage);

    if (given) {
        return given;
    }

    const transcript = str(payload.raw.transcript_path) ?? str(payload.raw.transcriptPath);

    if (!transcript) {
        return "";
    }

    try {
        const lines = read(transcript).split("\n");

        for (let index = lines.length - 1; index >= 0; index--) {
            const text = assistantText(lines[index] ?? "");

            if (text) {
                return text;
            }
        }
    } catch (err) {
        hookDiag("Could not read the transcript for the final reply", { err, transcript });
    }

    return "";
}

const fileCounts = {
    read: (session: string) => readContextCounts(session)[STOP_BLOCK_COUNTER] ?? 0,
    bump: (session: string) => bumpContextCounts(session, [STOP_BLOCK_COUNTER]),
};

const fileNudgeState: NudgeState = {
    blocks: (session) => readContextCounts(session)[NUDGE_BLOCK_COUNTER] ?? 0,
    lastTurn: (session) => readContextCounts(session)[NUDGE_TURN_KEY],
    record: (session, turn, blocked) => {
        const blocks = readContextCounts(session)[NUDGE_BLOCK_COUNTER] ?? 0;

        setContextValues(session, { [NUDGE_TURN_KEY]: turn, [NUDGE_BLOCK_COUNTER]: blocked ? blocks + 1 : blocks });
    },
};

const fileChatState: ChatAnswerState = {
    checkedAt: (session) => readContextCounts(session)[CHAT_CHECKED_KEY],
    setCheckedAt: (session, at) => setContextValues(session, { [CHAT_CHECKED_KEY]: at }),
    sentBack: (session, id) => readContextCounts(session)[`${CHAT_SENT_BACK_PREFIX}${id}`] !== undefined,
    markSentBack: (session, ids) =>
        setContextValues(session, Object.fromEntries(ids.map((id) => [`${CHAT_SENT_BACK_PREFIX}${id}`, 1]))),
};

function lettersFor(count: number): string[] {
    return Array.from({ length: count }, (_, index) => String.fromCharCode(97 + index));
}

/** When a decision was asked as it stands: its latest revision, else its post. */
function askedAt(row: DecisionRecord): string {
    return row.revisedTs ?? row.createdTs ?? row.updatedTs;
}

function quoted(evidence: { text: string }): string {
    const text = evidence.text.length > 160 ? `${evidence.text.slice(0, 159)}…` : evidence.text;

    return SafeJSON.stringify(text);
}

function answerLine(row: DecisionRecord, answer: ChatAnswer): string {
    return `❓ DECISION ${row.number}: ${answer.option ? `${answer.option}) ` : ""}from ${quoted(answer.evidence)}`;
}

function unclearLine(row: DecisionRecord, item: AmbiguousAnswer): string {
    return `❓ DECISION ${row.number} (${item.reason}): ${quoted(item.evidence)}`;
}

/**
 * The chat-answer step (`decisions.chatAnswers`): the open decisions of the session, the transcript since the oldest
 * was asked (or since the last check, whichever is later) read through the session's provider, and the user's chat
 * answers in it. `record` stores each unambiguous one as `automatic_heuristic` and tells the user; an unclear one,
 * and in `remind` every one found, sends the agent back once per decision to record it with question_update.
 */
async function runChatAnswers(
    payload: HookPayload,
    session: string,
    config: DecisionsHookConfig,
    deps: DecisionHookDeps
): Promise<StopHookOutput | null> {
    const transcriptPath = str(payload.raw.transcript_path) ?? str(payload.raw.transcriptPath);

    if (config.chatAnswers === "off" || !deps.readSession || !transcriptPath) {
        return null;
    }

    const open = readDecisions(deps.log.file).filter(
        (row) =>
            row.sessionId === session && kindOf(row) === "decision" && (row.state === "open" || row.state === "drafted")
    );

    if (open.length === 0) {
        return null;
    }

    const state = deps.chat ?? fileChatState;
    const now = deps.now?.() ?? Date.now();
    const asked = open.map((row) => Date.parse(askedAt(row))).filter(Number.isFinite);
    const from = Math.max(asked.length > 0 ? Math.min(...asked) : 0, state.checkedAt(session) ?? 0);
    const read = await deps.readSession({
        kind: payload.harness,
        transcriptPath,
        maxBytes: CHAT_READ_BYTES,
        until: (entry) => {
            const at = entry.timestamp ? Date.parse(entry.timestamp) : Number.NaN;

            return Number.isFinite(at) && at < from;
        },
    });
    state.setCheckedAt(session, now);

    if (!read.found && from > 0) {
        // Not an error for Grok (its rows carry no time), but for Claude and Codex a read that never reached the
        // oldest open ask means an answer before the cut is not seen.
        hookDiag("Chat answers: the read ended before the oldest open ask", {
            session,
            harness: payload.harness,
            from: new Date(from).toISOString(),
            entries: read.entries.length,
            issues: read.issues.slice(0, 3),
        });
    }

    const byNumber = new Map(open.map((row) => [row.number, row]));
    const found = chatAnswers(
        read.entries,
        open.map((row) => ({ number: row.number, letters: lettersFor(row.options.length), askedAt: askedAt(row) }))
    );
    const pairs = <T extends { number: number }>(items: T[]) =>
        items.flatMap((item) => {
            const row = byNumber.get(item.number);

            return row ? [{ row, item }] : [];
        });
    const answers = pairs(found.unambiguous);
    const unclear = pairs(found.ambiguous);
    let recorded: DecisionRecord[] = [];

    if (config.chatAnswers === "record" && answers.length > 0) {
        recorded = await recordChatAnswers({
            file: deps.log.file,
            events: deps.log.events,
            answers: answers.map(({ row, item }) => ({
                id: row.id,
                ...(item.option ? { option: item.option } : {}),
                answer: item.answer,
                evidence: item.evidence,
            })),
        });
    }

    const recordedNote =
        recorded.length > 0
            ? `Recorded the chat answer to ❓ DECISION ${recorded.map((row) => `${row.number}${row.option ? ` ${row.option})` : ""}`).join(", ")} from the transcript (automatic_heuristic).`
            : "";
    const toRecord =
        config.chatAnswers === "remind" ? answers.filter(({ row }) => !state.sentBack(session, row.id)) : [];
    const toCheck = unclear.filter(({ row }) => !state.sentBack(session, row.id));

    if (toRecord.length === 0 && toCheck.length === 0) {
        return recordedNote ? { systemMessage: recordedNote } : null;
    }

    state.markSentBack(
        session,
        [...toRecord, ...toCheck].map(({ row }) => row.id)
    );
    const parts = [
        recordedNote,
        toRecord.length > 0
            ? `The user answered in the chat:\n${toRecord.map(({ row, item }) => answerLine(row, item)).join("\n")}\nRecord each with question_update (state acknowledged, option or answer) unless you already did.`
            : "",
        toCheck.length > 0
            ? `The user's messages since these decisions were asked talk about them without a clear answer:\n${toCheck.map(({ row, item }) => unclearLine(row, item)).join("\n")}\nIf one is an answer, record it with question_update (state acknowledged, option or answer); otherwise leave it open.`
            : "",
        "The decision Stop hook says this once per decision.",
    ];

    return { decision: "block", reason: parts.filter(Boolean).join("\n\n") };
}

/** Two Stop outputs as one: any block wins and carries every text. */
function mergedStop(outputs: (StopHookOutput | null)[]): StopHookOutput | null {
    const given = outputs.filter((output): output is StopHookOutput => output !== null);
    const texts = given.map((output) => ("decision" in output ? output.reason : output.systemMessage));

    if (given.length === 0) {
        return null;
    }

    return given.some((output) => "decision" in output)
        ? { decision: "block", reason: texts.join("\n\n") }
        : { systemMessage: texts.join(" ") };
}

/**
 * The time (epoch ms) of a transcript line when it is a prompt that opens a turn, else null. Claude: a `user` row
 * that is not `isMeta` (Stop hook feedback and injected skill text are meta) and carries text, not only tool
 * results; a background task's notification counts, since it starts a turn too. Codex: a `user` message item or a
 * `user_message` event. Both write a top-level ISO `timestamp`.
 */
function promptTime(line: string): number | null {
    if (!line.includes('"type":"user"') && !line.includes('"role":"user"') && !line.includes('"user_message"')) {
        return null;
    }

    let row: unknown;

    try {
        row = SafeJSON.parse(line, { strict: true });
    } catch {
        // The first line of a tail read starts mid-row; it is not a prompt either way.
        return null;
    }

    if (typeof row !== "object" || row === null) {
        return null;
    }

    const record = row as {
        type?: unknown;
        isMeta?: unknown;
        isSidechain?: unknown;
        timestamp?: unknown;
        message?: { content?: unknown };
        payload?: { type?: unknown; role?: unknown };
    };
    const at = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : Number.NaN;

    if (Number.isNaN(at)) {
        return null;
    }

    if (record.type === "user") {
        const content = record.message?.content;
        const hasText =
            typeof content === "string"
                ? content.length > 0
                : Array.isArray(content) && content.some((block: { type?: unknown }) => block?.type === "text");

        return hasText && record.isMeta !== true && record.isSidechain !== true ? at : null;
    }

    const payload = record.payload;
    const codexPrompt =
        (record.type === "response_item" && payload?.type === "message" && payload.role === "user") ||
        (record.type === "event_msg" && payload?.type === "user_message");

    return codexPrompt ? at : null;
}

/**
 * When the turn this Stop ends began: the time of the last prompt in the transcript (`promptTime`), epoch ms. Null
 * when the payload names no transcript, it cannot be read, or its last `PROMPT_TAIL_BYTES` hold no prompt.
 */
export function turnStartedAt(
    payload: HookPayload,
    read: (path: string) => string = (path) => readTail(path, PROMPT_TAIL_BYTES)
): number | null {
    const transcript = str(payload.raw.transcript_path) ?? str(payload.raw.transcriptPath);

    if (!transcript) {
        return null;
    }

    try {
        const lines = read(transcript).split("\n");

        for (let index = lines.length - 1; index >= 0; index--) {
            const at = promptTime(lines[index] ?? "");

            if (at !== null) {
                return at;
            }
        }
    } catch (err) {
        hookDiag("Could not read the transcript for the turn's prompt", { err, transcript });
    }

    return null;
}

/** Whether the session posted a decision at or after `since`: a new post, or a new version of one. */
function decisionLoggedSince(file: string, session: string, since: number): boolean {
    return readDecisions(file).some(
        (row) =>
            row.sessionId === session &&
            kindOf(row) === "decision" &&
            Date.parse(row.revisedTs ?? row.createdTs ?? row.updatedTs) >= since
    );
}

/**
 * The question nudge: a reply that asks the user to decide (`decisionQuestion`) while the session posted no decision
 * since the turn's prompt. It speaks at most once per turn. A Stop that follows a Stop hook's block passes
 * (`stop_hook_active`, sent by Claude Code), and so does any later Stop of a turn it already spoke in, which covers a
 * harness that does not send that flag.
 */
function runQuestionNudge({
    payload,
    session,
    reply,
    config,
    deps,
}: {
    payload: HookPayload;
    session: string;
    reply: string;
    config: DecisionsHookConfig;
    deps: DecisionHookDeps;
}): StopHookOutput | null {
    const question = decisionQuestion(reply);

    if (!question || payload.raw.stop_hook_active === true || payload.raw.stopHookActive === true) {
        return null;
    }

    const turn = turnStartedAt(payload, deps.readTail);

    if (turn === null) {
        hookDiag("The question nudge found no prompt in the transcript, so it stays quiet", { session });
        return null;
    }

    const state = deps.nudge ?? fileNudgeState;

    if (state.lastTurn(session) === turn) {
        return null;
    }

    const verdict = questionNudgeVerdict(
        {
            questionNudge: config.questionNudge,
            maxBlocksPerSession: config.maxBlocksPerSession,
            blocksUsed: state.blocks(session),
        },
        question,
        decisionLoggedSince(deps.log.file, session, turn)
    );

    if (verdict.action === "block" && verdict.reason) {
        state.record(session, turn, true);
        return { decision: "block", reason: verdict.reason };
    }

    if (verdict.action === "warn" && verdict.reason) {
        state.record(session, turn, false);
        return { systemMessage: verdict.reason };
    }

    return null;
}

/**
 * The Stop hook. Returns null, meaning "print nothing", for every turn it has no business with:
 * the feature off, a harness not listed, no session, or a reply that asks no `❓ DECISION` and,
 * with the question nudge on, nothing for the user to decide.
 * A reply that names `❓ DECISION N` is this check's alone: it harvests unposted blocks when asked
 * to, then warns or blocks on what is still unposted. A block is counted per session, and past
 * `maxBlocksPerSession` it only warns. Any other reply goes to the question nudge (`runQuestionNudge`).
 * Before those, the chat-answer step (`decisions.chatAnswers`) records answers the user typed in the chat.
 */
export async function runDecisionStop(
    payload: HookPayload,
    config: DecisionsHookConfig,
    deps: DecisionHookDeps
): Promise<StopHookOutput | null> {
    const session = safeSessionId(payload.sessionId);

    if (!session || !config.harnesses.includes(payload.harness)) {
        return null;
    }

    let chat: StopHookOutput | null = null;

    try {
        chat = await runChatAnswers(payload, session, config, deps);
    } catch (err) {
        // A chat read that fails costs the automatic record, never the reply checks below.
        hookDiag("Chat answers failed; the reply checks still run", { err, session });
    }

    return mergedStop([chat, await runReplyChecks(payload, session, config, deps)]);
}

/** The checks on the reply itself: unposted `❓ DECISION N` blocks (harvest, warn, block) and the question nudge. */
async function runReplyChecks(
    payload: HookPayload,
    session: string,
    config: DecisionsHookConfig,
    deps: DecisionHookDeps
): Promise<StopHookOutput | null> {
    const nudging = config.questionNudge !== "off";

    if (config.stopHook === "off" && !config.harvest && !nudging) {
        return null;
    }

    const reply = finalReply(payload, deps.readTail);
    const mentioned = mentionedDecisions(reply);

    if (mentioned.length === 0) {
        return nudging ? runQuestionNudge({ payload, session, reply, config, deps }) : null;
    }

    if (config.stopHook === "off" && !config.harvest) {
        return null;
    }

    const posted = () =>
        readDecisions(deps.log.file)
            .filter((row) => row.sessionId === session && kindOf(row) === "decision")
            .map((row) => row.number);
    let harvested: number[] = [];

    if (config.harvest) {
        const known = new Set(posted());
        const found = parseDecisionBlocks(reply).filter((block) => !known.has(block.number));
        const stored = await harvestDecisions(deps.log.file, deps.log.events, {
            sessionId: session,
            provider: payload.harness,
            cwd: payload.cwd,
            found,
        });
        harvested = stored.map((row) => row.number);
    }

    const counts = deps.counts ?? fileCounts;
    const verdict = stopHookVerdict(
        {
            stopHook: config.stopHook,
            maxBlocksPerSession: config.maxBlocksPerSession,
            blocksUsed: counts.read(session),
        },
        reply,
        posted()
    );
    const harvestNote =
        harvested.length > 0
            ? `Stored ❓ DECISION ${harvested.join(", ")} from the reply so the hub shows ${harvested.length === 1 ? "it" : "them"}.`
            : "";

    if (verdict.action === "block" && verdict.reason) {
        counts.bump(session);
        return { decision: "block", reason: verdict.reason };
    }

    if (verdict.action === "warn" && verdict.reason) {
        return { systemMessage: [verdict.reason, harvestNote].filter(Boolean).join(" ") };
    }

    return harvestNote ? { systemMessage: harvestNote } : null;
}

export interface PromptHookOutput {
    hookSpecificOutput: { hookEventName: "UserPromptSubmit"; additionalContext: string };
}

function promptOutput(text: string, numbers: number[]): PromptHookOutput {
    const one = numbers.length === 1;

    return {
        hookSpecificOutput: {
            hookEventName: "UserPromptSubmit",
            additionalContext:
                `The user answered ${one ? "a decision" : `${numbers.length} decisions`} in the hub:\n` +
                `${text}\n` +
                `Act on ${one ? "it" : "them"}, then mark ${one ? "it" : "each"} acknowledged (and later implemented, ` +
                "with commit refs) through question_update.",
        },
    };
}

/**
 * The UserPromptSubmit hook: answered decisions nobody delivered yet ride along with the
 * session's next prompt. `emit` writes the hook output INSIDE the send, so the rows count as
 * `sent` only once the harness has the bytes: a write that fails puts them back to `answered`
 * for the next prompt. Null when the feature is off, the harness is not listed, or nothing is due.
 */
export async function runDecisionInject(
    payload: HookPayload,
    config: DecisionsHookConfig,
    deps: DecisionHookDeps & { emit: (output: PromptHookOutput) => unknown }
): Promise<PromptHookOutput | null> {
    const session = safeSessionId(payload.sessionId);

    if (!config.injectAnswers || !session || !config.harnesses.includes(payload.harness)) {
        return null;
    }

    let sent: SentDecisions;
    let output: PromptHookOutput | null = null;

    try {
        sent = await sendSessionDecisions({
            file: deps.log.file,
            events: deps.log.events,
            session,
            emit: async (text, numbers) => {
                output = promptOutput(text, numbers);
                await deps.emit(output);
            },
        });
    } catch (err) {
        if (err instanceof Error && err.message === "nothing to send") {
            return null;
        }

        throw err;
    }

    // The rows are `sent` now; without this their delivery still reads "queued" from the send
    // that found no pane, and the hub and /qa would say the answer is still waiting for a prompt.
    // The answers already reached the harness, so a failure here is logged, not thrown.
    try {
        const ids = readDecisions(deps.log.file)
            .filter(
                (row) => row.sessionId === session && kindOf(row) === "decision" && sent.numbers.includes(row.number)
            )
            .map((row) => row.id);
        await recordDelivery(deps.log.file, deps.log.events, ids, { route: "prompt" });
    } catch (err) {
        hookDiag("The answers were delivered, but their delivery route was not recorded", { err, session });
    }

    return output;
}

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import {
    decisionQuestion,
    mentionedDecisions,
    parseDecisionBlocks,
    questionNudgeVerdict,
    type SentDecisions,
    sendSessionDecisions,
    stopHookVerdict,
} from "@app/question/lib/decisions/read";
import { harvestDecisions, kindOf, readDecisions, recordDelivery } from "@app/question/lib/decisions/store";
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

export interface DecisionHookDeps {
    log: DecisionLogPaths;
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
 */
export async function runDecisionStop(
    payload: HookPayload,
    config: DecisionsHookConfig,
    deps: DecisionHookDeps
): Promise<StopHookOutput | null> {
    const session = safeSessionId(payload.sessionId);
    const nudging = config.questionNudge !== "off";

    if (
        (config.stopHook === "off" && !config.harvest && !nudging) ||
        !session ||
        !config.harnesses.includes(payload.harness)
    ) {
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

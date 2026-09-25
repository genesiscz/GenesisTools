import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import {
    mentionedDecisions,
    parseDecisionBlocks,
    type SentDecisions,
    sendSessionDecisions,
    stopHookVerdict,
} from "@app/question/lib/decisions/read";
import { harvestDecisions, kindOf, readDecisions, recordDelivery } from "@app/question/lib/decisions/store";
import { SafeJSON } from "@genesiscz/utils/json";
import type { DecisionsHookConfig } from "./config";
import { hookDiag } from "./log";
import type { HookPayload } from "./payload";
import { bumpContextCounts, readContextCounts, safeSessionId } from "./state";

/** The per-session counter the loop guard reads; it lives beside the guard's context counts. */
export const STOP_BLOCK_COUNTER = "decisions-stop-block";

/** How much of a transcript's end is read to find the last reply. A final reply is far smaller. */
const TAIL_BYTES = 512 * 1024;

export interface DecisionLogPaths {
    file: string;
    events: string;
}

export interface DecisionHookDeps {
    log: DecisionLogPaths;
    /** The loop guard's counter store; tests pass an in-memory one. */
    counts?: { read: (session: string) => number; bump: (session: string) => void };
    readTail?: (path: string) => string;
}

export type StopHookOutput = { decision: "block"; reason: string } | { systemMessage: string };

function str(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readTail(path: string): string {
    const fd = openSync(path, "r");

    try {
        const size = fstatSync(fd).size;
        const start = Math.max(0, size - TAIL_BYTES);
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

/**
 * The Stop hook. Returns null, meaning "print nothing", for every turn it has no business with:
 * the feature off, a harness not listed, no session, or a reply that asks no `❓ DECISION`.
 * Otherwise it harvests unposted blocks when asked to, then warns or blocks on what is still
 * unposted. A block is counted per session, and past `maxBlocksPerSession` it only warns.
 */
export async function runDecisionStop(
    payload: HookPayload,
    config: DecisionsHookConfig,
    deps: DecisionHookDeps
): Promise<StopHookOutput | null> {
    const session = safeSessionId(payload.sessionId);

    if ((config.stopHook === "off" && !config.harvest) || !session || !config.harnesses.includes(payload.harness)) {
        return null;
    }

    const reply = finalReply(payload, deps.readTail);
    const mentioned = mentionedDecisions(reply);

    if (mentioned.length === 0) {
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

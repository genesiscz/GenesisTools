import { join } from "node:path";
import type { AmbiguousAnswer, ChatAnswer } from "@app/question/lib/decisions/chat-answers";
import { readJsonlRows } from "@genesiscz/utils/jsonl";
import { agentsDataDir } from "./config";
import { appendHookRecord } from "./log";

/**
 * Every run of the decision Stop hook's chat-answer step (`decisions.chatAnswers`), one JSONL record each: the open
 * decisions, every user message it read, and what it made of them. It exists so a missed answer can be found later:
 * `tools agents hooks chat-answers --misses` lists the messages that matched nothing while decisions were open.
 */
export function chatAnswerLogPath(): string {
    return join(agentsDataDir(), "chat-answers.jsonl");
}

/** A user message as the log keeps it: its start, plus every line that looks like it names a decision or an option. */
export interface LoggedUserMessage {
    line: number;
    timestamp?: string;
    text: string;
    /** Lines past the start that name a decision or open with an option letter, so a long message's answer shows. */
    candidates?: string[];
}

export interface ChatAnswerRun {
    at: string;
    harness: string;
    session: string;
    transcript: string;
    mode: "record" | "remind";
    open: { id: string; number: number; askedAt: string }[];
    /**
     * Where the read went: `from` is the time a first read went back to and `found` whether it got there;
     * `fromOffset` the byte a read from the last read's end started at; `endOffset` where the next one starts.
     */
    read: { from?: string; fromOffset?: number; endOffset?: number; found: boolean; entries: number; issues: number };
    users: LoggedUserMessage[];
    unambiguous: ChatAnswer[];
    ambiguous: AmbiguousAnswer[];
    /** Decision ids stored as `automatic_heuristic` in this run. */
    recorded: string[];
    /** Decision ids the agent was sent back about in this run. */
    sentBack: string[];
}

const START_CHARS = 300;
const CANDIDATE =
    /\bD(?:ECISION)?\s*#?\d+\b|^\s*(?:[-*]\s+)?\d+\s*[:.)\-–—]?\s*\(?[a-z]{1,4}\)?(?:\s|$)|^\s*\(?[a-z]\)/i;
const MAX_CANDIDATES = 12;

/** The user message as the log keeps it (`LoggedUserMessage`). */
export function loggedUserMessage(entry: { line: number; timestamp?: string; text: string }): LoggedUserMessage {
    const text = entry.text.trim();
    const start = text.length > START_CHARS ? `${text.slice(0, START_CHARS - 1)}…` : text;
    const candidates = text
        .slice(START_CHARS)
        .split("\n")
        .filter((line) => CANDIDATE.test(line))
        .slice(0, MAX_CANDIDATES)
        .map((line) => line.trim().slice(0, 200));

    return {
        line: entry.line,
        ...(entry.timestamp ? { timestamp: entry.timestamp } : {}),
        text: start,
        ...(candidates.length > 0 ? { candidates } : {}),
    };
}

export function appendChatAnswerRun(run: ChatAnswerRun, path = chatAnswerLogPath()): void {
    appendHookRecord(path, { ...run });
}

/** The runs in the log (and its rotated generation), oldest first; a session filter matches an id prefix. */
export function readChatAnswerRuns({
    path = chatAnswerLogPath(),
    session,
}: {
    path?: string;
    session?: string;
} = {}): ChatAnswerRun[] {
    const rows: ChatAnswerRun[] = [];

    for (const file of [`${path}.1`, path]) {
        for (const row of readJsonlRows<ChatAnswerRun>(file).rows) {
            if (!session || row.session?.startsWith(session)) {
                rows.push(row);
            }
        }
    }

    return rows;
}

/** What one user message of a run led to: an answer recorded or found, an unclear mention, or nothing. */
export function userMessageOutcome(run: ChatAnswerRun, message: LoggedUserMessage): string {
    const same = (evidence: { line: number }) => evidence.line === message.line;
    const answers = run.unambiguous.filter((answer) => same(answer.evidence));
    const unclear = run.ambiguous.filter((item) => same(item.evidence));
    const parts = [
        ...answers.map((answer) => {
            const id = run.open.find((row) => row.number === answer.number)?.id;
            const stored = id && run.recorded.includes(id) ? "recorded" : "found";

            return `${stored} D${answer.number}${answer.option ? ` ${answer.option})` : ""}`;
        }),
        ...unclear.map((item) => `unclear D${item.number} (${item.reason})`),
    ];

    return parts.length > 0 ? parts.join(", ") : "no match";
}

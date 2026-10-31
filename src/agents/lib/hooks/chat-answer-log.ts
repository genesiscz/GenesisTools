import { join } from "node:path";
import type { ChatAnswerRun } from "@app/question/lib/decisions/chat-answer-run";
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

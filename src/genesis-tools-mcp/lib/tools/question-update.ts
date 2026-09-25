import { decisionFiles } from "@app/question/lib/decisions/read";
import { decisionBatchUpdateSchema } from "@app/question/lib/decisions/schema";
import { updateDecisions } from "@app/question/lib/decisions/store";
import { SafeJSON } from "@genesiscz/utils/json";
import { z } from "zod";

/** Generated from the same zod schema the store validates with. */
export const QUESTION_UPDATE_INPUT_SCHEMA = z.toJSONSchema(decisionBatchUpdateSchema, { io: "input" });

export const QUESTION_UPDATE_DESCRIPTION =
    "Update decisions and todos you posted with question_post (type decision|todo), several per call, as ONE " +
    "change: a batch with an unknown id or an illegal move changes nothing. Per item: `state` (decision: open → " +
    "answered|drafted, drafted → answered, answered → sent, sent → acknowledged, acknowledged → implemented; todo: " +
    "open → acknowledged|implemented, acknowledged → implemented), `answer` (a copy of an answer the user gave in " +
    "chat), `option` (the letter), `commitRefs`, `verdict`, `comment` (appended). Mark a delivered answer " +
    "`acknowledged` once you act on it and `implemented` with commitRefs when it is done.";

export async function handleQuestionUpdate(
    args: unknown,
    deps: { decisionLog?: { file: string; events: string } } = {}
): Promise<string> {
    const { file, events } = deps.decisionLog ?? decisionFiles();
    const updated = await updateDecisions(file, events, args);
    return SafeJSON.stringify({ updated, events });
}

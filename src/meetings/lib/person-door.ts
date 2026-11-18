import type { AreaClients } from "@genesiscz/utils/genesis-tools";
import { sha256Json } from "@genesiscz/utils/hash";
import type { DecisionActor, MeetingRecord } from "@genesiscz/utils/meetings/record";
import { shellWord } from "@genesiscz/utils/shell/quote";
import { errorText, TOOL } from "./shared";

/** Call after the record is saved. A delivery failure is a warning on the completed run. */
export async function requestMeetingQuestionReview(options: {
    actor: DecisionActor;
    runId: string;
    record: Pick<MeetingRecord, "id" | "title" | "items">;
    gt?: { person: Pick<AreaClients["person"], "notice"> };
}): Promise<string | undefined> {
    const { actor, record, runId } = options;
    if (actor.kind !== "agent") {
        return;
    }

    const pending = record.items.some(
        (item) =>
            item.kind === "question" &&
            item.status === "suggested" &&
            (item.about === "dictionary" || (item.about === "term" && item.group === "words"))
    );
    if (!pending) {
        return;
    }

    // A v1 notice carries text only. Its request window can still give the owner the exact Items command.
    const command = `${TOOL} window ${shellWord(record.id)} --tab items`;
    try {
        const gt = options.gt ?? (await import("@genesiscz/utils/genesis-tools")).gt;
        const outcome = await gt.person.notice({
            id: `meeting-questions:${sha256Json([record.id, runId])}`,
            title: "Meeting words need your review",
            reason: `Review the word questions in the Items tab for ${record.title || record.id}.\n${command}`,
        });
        if (outcome.status === "unreachable") {
            return outcome.manual ?? `The meeting review request could not reach you. Open Items with ${command}`;
        }

        if (outcome.value.status === "failed" || outcome.value.status === "unreachable") {
            return outcome.value.reason ?? `The meeting review request failed. Open Items with ${command}`;
        }
    } catch (error) {
        return `Could not post the meeting review request: ${errorText(error)}`;
    }
}

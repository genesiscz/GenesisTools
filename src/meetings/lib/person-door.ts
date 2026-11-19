import { env } from "@genesiscz/utils/env";
import type { AreaClients } from "@genesiscz/utils/genesis-tools";
import { sha256Json } from "@genesiscz/utils/hash";
import type { DecisionActor, MeetingRecord } from "@genesiscz/utils/meetings/record";
import { shellWord } from "@genesiscz/utils/shell/quote";
import { sandboxInstalled } from "@genesiscz/utils/storage/real-home-guard";
import { errorText, TOOL } from "./shared";

/** The part of the person area the meetings tools call. */
export type MeetingReviewDoor = { person: Pick<AreaClients["person"], "windowNotice"> };

/** Call after the record is saved. A delivery failure is a warning on the completed run. */
export async function requestMeetingQuestionReview(options: {
    actor: DecisionActor;
    runId: string;
    record: Pick<MeetingRecord, "id" | "title" | "items">;
    gt?: MeetingReviewDoor;
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

    // A click opens the Items tab. The command stays in the text for the request window and for a terminal.
    const command = `${TOOL} window ${shellWord(record.id)} --tab items`;
    // A sandbox home (GENESIS_TOOLS_HOME elsewhere: probes, measures, copies) must not reach the real person:
    // the app and its notifications are shared by every home on this Mac.
    if (!options.gt && sandboxInstalled()) {
        return `Sandbox home ${env.tools.getHome()}: no review request was sent. Open Items with ${command}`;
    }
    try {
        const gt = options.gt ?? (await import("@genesiscz/utils/genesis-tools")).gt;
        const outcome = await gt.person.windowNotice({
            id: `meeting-questions:${sha256Json([record.id, runId])}`,
            title: "Meeting words need your review",
            reason: `Review the word questions in the Items tab for ${record.title || record.id}.\n${command}`,
            open: { window: "--meetings", args: ["--meeting", record.id, "--tab", "items"] },
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

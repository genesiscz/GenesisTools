import { decisionLines, dueDecisions, optionLetters } from "../decisions/read";
import { awaitsDelivery, type DecisionRecord, kindOf } from "../decisions/store";

/**
 * What a send would deliver, without the delivery code: `inbox --session <id> --json --all-items` shows the staged
 * message, and loading `drafts.ts` for it pulled the cmux and codex delivery modules into every such call.
 */

/** A drafted decision the send would promote: an unsent pick or note on an open row. */
export function isDrafted(row: DecisionRecord): boolean {
    return (
        kindOf(row) === "decision" &&
        (row.state === "open" || row.state === "drafted") &&
        (Boolean(row.draftOption) || Boolean(row.draft?.trim()))
    );
}

/** What a send turns a draft into: the pick becomes the option, the note the answer. */
export function promotedDraft(row: DecisionRecord): Pick<DecisionRecord, "option" | "answer"> {
    return {
        ...(row.draftOption ? { option: optionLetters(row.draftOption).join("") } : {}),
        ...(row.draft?.trim() ? { answer: row.draft.trim() } : {}),
    };
}

/**
 * The message the session's next `sendDrafts` submits, from the rows as they stand: its drafts promoted as the send
 * promotes them, plus answers already waiting to go out, in the send's own format (`deliverDecisions`). The mods
 * Decisions sidebar shows it above its `[send]`, so what it shows is what goes out. `undefined` when nothing would.
 */
export function stagedSendText(rows: DecisionRecord[], session: string): string | undefined {
    const due = dueDecisions(
        rows
            .filter((row) => row.sessionId === session && kindOf(row) === "decision")
            .flatMap((row) => {
                if (isDrafted(row)) {
                    return [{ ...row, state: "answered" as const, ...promotedDraft(row) }];
                }

                // A chat answer an agent recorded as `answered` is not waiting to go out (`awaitsDelivery`).
                return awaitsDelivery(row) ? [row] : [];
            })
    );

    return due.length > 0 ? decisionLines(due) : undefined;
}

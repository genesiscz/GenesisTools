import type { DecisionActor, MeetingRecord, MeetingStore } from "@genesiscz/utils/meetings/record";
import { callerActor, type Decided, DecisionJournal, type DecisionSkip } from "./decision-journal";

/**
 * What a confirm or reject did: the items it decided, and each one it left with the reason and how to decide it.
 * `token` names this decision, its decision journal entry: its Undo (`reopen --token`) is refused once another decision
 * changed the item.
 */
export interface DecideResult {
    decided: string[];
    token?: string;
    /**
     * `needs`: what decides it, a `speaker` or `proposed` value, or an answer by ear (`listen`); `nothing` when it is
     * decided that way already, which is no failure.
     */
    skipped: Array<{ id: string; reason: string; needs: "speaker" | "proposed" | "listen" | "nothing" }>;
}

/** What a reopen did: the items it put back, and each one it left with the reason. */
export interface ReopenResult {
    reopened: string[];
    skipped: Array<{ id: string; reason: string }>;
}

/** Who decides when the caller does not say: the agent this process runs for, else a person at the command line. */
interface ActorOptions {
    actor?: DecisionActor;
    reason?: string;
}

/** A confirm's or reject's journal result in the shape `confirm --json` and the REPL's meeting.confirm() print. */
export function decideResult(decided: Decided): DecideResult {
    const skipped = decided.skipped.map((skip) => ({
        id: skip.id,
        reason: skip.reason,
        needs: skip.needs ?? "nothing",
    }));
    return decided.entry
        ? { decided: decided.entry.decided, token: decided.entry.token, skipped }
        : { decided: [], skipped };
}

/** A reopen's or Undo's journal result in the shape `reopen --json` and the REPL's items.reopen() print. */
export function reopenResult(decided: Decided): ReopenResult {
    const reopened = (decided.entry?.changes ?? []).map((change) => change.id);
    return {
        reopened,
        skipped: decided.skipped.map((skip: DecisionSkip) => ({ id: skip.id, reason: skip.reason })),
    };
}

/**
 * Confirms or rejects items in one save, the CLI's `confirm` and `reject` and the REPL's meeting.confirm() and
 * meeting.reject(), through the decision journal. A question (Q12 or its id) is answered by ear, not confirmed; a range
 * nobody named or a term with no spelling needs `speaker` or `proposed`. Those are skipped with the reason; the rest
 * are decided, and each confirmed correction goes into the corrections ledger.
 */
export async function decideItems(
    options: {
        store: MeetingStore;
        record: MeetingRecord;
        status: "confirmed" | "rejected";
        ids: string[];
        minConfidence?: number;
        speaker?: string;
        proposed?: string;
    } & ActorOptions
): Promise<DecideResult> {
    const { store, record, status, ids, minConfidence, speaker, proposed } = options;
    const journal = new DecisionJournal({ store });
    const decided = await journal.apply({
        meeting: record.id,
        action:
            status === "confirmed"
                ? {
                      kind: "confirm",
                      items: ids,
                      ...(minConfidence !== undefined ? { minConfidence } : {}),
                      ...(speaker !== undefined ? { speaker } : {}),
                      ...(proposed !== undefined ? { proposed } : {}),
                  }
                : { kind: "reject", items: ids, ...(minConfidence !== undefined ? { minConfidence } : {}) },
        actor: options.actor ?? callerActor(),
        ...(options.reason ? { reason: options.reason } : {}),
    });
    return decideResult(decided);
}

/**
 * Takes back the decision of items: the Undo of a confirm or a reject. With `token` (a `DecideResult.token`, any
 * decision journal token) it reverts that decision for these items, refused (`item-changed`) when another decision
 * changed one of them since; a question named brings back its whole answer. Without one each item goes back to the
 * state before its own last decision; a question is never reopened that way, because its answer also decided other
 * items. The corrections ledger is append-only, so a confirm's line stays and a retraction line follows it, which
 * `dictionary suggest` reads as the confirmation withdrawn.
 */
export async function reopenItems(
    options: { store: MeetingStore; record: MeetingRecord; ids: string[]; token?: string } & ActorOptions
): Promise<ReopenResult> {
    const { store, record, ids, token } = options;
    const journal = new DecisionJournal({ store });
    const actor = options.actor ?? callerActor();
    const reason = options.reason ? { reason: options.reason } : {};
    const decided = token
        ? await journal.revert({ meeting: record.id, token, items: ids, actor, ...reason })
        : await journal.apply({ meeting: record.id, action: { kind: "reopen", items: ids }, actor, ...reason });
    return reopenResult(decided);
}

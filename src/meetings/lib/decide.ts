import { randomUUID } from "node:crypto";
import { MeetingsConflictError } from "@genesiscz/utils/meetings/conflict";
import { appendCorrections, type Correction } from "@genesiscz/utils/meetings/corrections";
import type { MeetingItem, MeetingRecord, MeetingStore } from "@genesiscz/utils/meetings/record";
import { questionIdOf, questionLabel } from "./questions";
import { TOOL } from "./shared";
import { decisionLedger, ledgerEntryFor } from "./transcript-corrections";

/**
 * What a confirm or reject did: the items it decided, and each one it left with the reason and how to decide it.
 * `token` names this decision: its Undo (`reopen --token`) is refused once another decision changed the item.
 */
export interface DecideResult {
    decided: string[];
    token?: string;
    /** `needs`: what decides it, a `speaker` or `proposed` value, or an answer by ear (`listen`). */
    skipped: Array<{ id: string; reason: string; needs: "speaker" | "proposed" | "listen" }>;
}

/** Picks the items a decision names: ids, or every suggested item at or above a confidence. */
function pickItems(record: MeetingRecord, ids: string[], minConfidence?: number): MeetingItem[] {
    if (minConfidence !== undefined) {
        return record.items.filter((item) => item.status === "suggested" && (item.confidence ?? 0) >= minConfidence);
    }

    const missing = ids.filter((id) => !record.items.some((item) => item.id === id));

    if (missing.length > 0) {
        throw new Error(`${record.id} has no item ${missing.join(", ")} (${TOOL} items ${record.id})`);
    }

    return record.items.filter((item) => ids.includes(item.id));
}

/**
 * Confirms or rejects items in one save, the CLI's `confirm` and `reject` and the REPL's meeting.confirm() and
 * meeting.reject(). A question (Q12 or its id) is answered by ear, not confirmed; a range nobody named or a term with no
 * spelling needs `speaker` or `proposed`. Those are skipped with the reason; the rest are decided, and each confirmed
 * correction goes into the corrections ledger.
 */
export async function decideItems(options: {
    store: MeetingStore;
    record: MeetingRecord;
    status: "confirmed" | "rejected";
    ids: string[];
    minConfidence?: number;
    speaker?: string;
    proposed?: string;
}): Promise<DecideResult> {
    const { store, record, status, minConfidence, speaker, proposed } = options;

    if (minConfidence !== undefined && !(minConfidence >= 0 && minConfidence <= 1)) {
        throw new Error(`minConfidence ${minConfidence} must be between 0 and 1 (0.8 = 80 %)`);
    }

    if (options.ids.length === 0 && minConfidence === undefined) {
        throw new Error("Name the items (i1 i2 …) or give a minimum confidence (0..1)");
    }

    // A question is named by its number as people see it (Q12) as well as by its id.
    const ids = options.ids.map((id) => (/^q\d+$/i.test(id) ? questionIdOf(record, id) : id));
    const picked = pickItems(record, ids, minConfidence);
    const skipped: DecideResult["skipped"] = [];

    if (status === "confirmed") {
        for (const item of picked) {
            if (item.kind === "question") {
                const label = questionLabel(record, item.id);
                skipped.push({
                    id: item.id,
                    reason: `${label} is a question; answer it by ear: ${TOOL} listen ${record.id} --item ${label}`,
                    needs: "listen",
                });
            } else if (item.kind === "speaker-range" && !item.speaker && !speaker) {
                const candidates = item.candidates?.length ? ` Candidates: ${item.candidates.join(", ")}.` : "";
                skipped.push({ id: item.id, reason: `it has no speaker yet.${candidates}`, needs: "speaker" });
            } else if (item.kind === "term" && !item.proposed && !item.meaning && !item.quote && !proposed) {
                skipped.push({ id: item.id, reason: `"${item.heard}" has no spelling yet.`, needs: "proposed" });
            }
        }
    }

    const deciding = picked.filter((item) => !skipped.some((skip) => skip.id === item.id));

    if (deciding.length === 0) {
        return { decided: [], skipped };
    }

    const now = new Date().toISOString();
    const token = randomUUID();
    const ledger: Correction[] = [];
    await store.update(
        record.id,
        { command: status === "confirmed" ? "confirm" : "reject", change: deciding.map((item) => item.id).join(" ") },
        (current) => {
            for (const item of current.items) {
                if (!deciding.some((one) => one.id === item.id)) {
                    continue;
                }

                const prior = ledgerEntryFor(current, item, now);
                item.decision = {
                    token,
                    previous: {
                        status: item.status,
                        ...(item.decidedAt ? { decidedAt: item.decidedAt } : {}),
                        ...(item.kind === "speaker-range" && item.speaker ? { speaker: item.speaker } : {}),
                        ...(item.kind === "term" && item.proposed ? { proposed: item.proposed } : {}),
                    },
                };
                item.status = status;
                item.decidedAt = now;

                if (status !== "confirmed") {
                    ledger.push(...decisionLedger(prior, undefined));
                    continue;
                }

                if (item.kind === "speaker-range" && speaker) {
                    item.speaker = speaker;
                }

                if (item.kind === "term" && proposed) {
                    item.proposed = proposed;
                }

                ledger.push(...decisionLedger(prior, ledgerEntryFor(current, item, now)));
            }
        }
    );
    appendCorrections(ledger);
    return { decided: deciding.map((item) => item.id), token, skipped };
}

/** The item as it was before its decision: `decision.previous`, else suggested. */
function restoreBefore(item: MeetingItem): void {
    const previous = item.decision?.previous;
    item.status = previous?.status ?? "suggested";

    if (previous?.decidedAt) {
        item.decidedAt = previous.decidedAt;
    } else {
        delete item.decidedAt;
    }

    if (previous && item.kind === "speaker-range") {
        if (previous.speaker) {
            item.speaker = previous.speaker;
        } else {
            delete item.speaker;
        }
    }

    if (previous && item.kind === "term") {
        if (previous.proposed) {
            item.proposed = previous.proposed;
        } else {
            delete item.proposed;
        }
    }

    delete item.decision;
}

function reopenSkips(record: MeetingRecord, picked: MeetingItem[]): Array<{ id: string; reason: string }> {
    return picked.flatMap((item) => {
        if (item.kind === "question") {
            return [
                {
                    id: item.id,
                    reason: `${questionLabel(record, item.id)} is a question; its answer is undone in listen`,
                },
            ];
        }

        return item.status === "suggested" ? [{ id: item.id, reason: "it is not decided" }] : [];
    });
}

/**
 * Takes back the decision of items: the Undo of a confirm or a reject. Each item gets back the fields the decision
 * changed (its status, a speaker or spelling the confirm gave); an item decided before this code kept them goes back to
 * suggested. A question is never reopened here, because its answer also decided other items; `listen` reopens its own
 * answers. The corrections ledger is append-only, so a confirm's line stays and a retraction line follows it, which
 * `dictionary suggest` reads as the confirmation withdrawn. `token` names the decision
 * being undone (a `DecideResult.token`): when another decision changed one of the items since, nothing is reopened
 * (`item-changed`). The items are checked again under the record's lock.
 */
export async function reopenItems(options: {
    store: MeetingStore;
    record: MeetingRecord;
    ids: string[];
    token?: string;
}): Promise<{ reopened: string[]; skipped: Array<{ id: string; reason: string }> }> {
    const { store, token } = options;
    // The saved record decides: the one passed in may be older than a confirm made since.
    const record = store.read(options.record.id) ?? options.record;
    const before = reopenSkips(record, pickItems(record, options.ids));

    if (before.length === options.ids.length) {
        return { reopened: [], skipped: before };
    }

    let reopened: string[] = [];
    let skipped = before;
    const retracted: Correction[] = [];
    await store.update(record.id, { command: "reopen", change: options.ids.join(" ") }, (current) => {
        const picked = pickItems(current, options.ids);
        skipped = reopenSkips(current, picked);
        const reopening = picked.filter((item) => !skipped.some((skip) => skip.id === item.id));

        if (token) {
            const changed = reopening.filter((item) => item.decision?.token !== token);

            if (changed.length > 0) {
                throw new MeetingsConflictError(
                    "item-changed",
                    `${changed.map((item) => `${item.id} (${item.status} now)`).join(", ")} was decided again after the decision this Undo names; nothing was reopened`
                );
            }
        }

        const now = new Date().toISOString();

        for (const item of reopening) {
            const confirmation = ledgerEntryFor(current, item, now);
            restoreBefore(item);
            // The Undo of a reject or a respelling brings the earlier confirmation back, so the ledger confirms it again.
            retracted.push(...decisionLedger(confirmation, ledgerEntryFor(current, item, now)));
        }

        reopened = reopening.map((item) => item.id);
    });
    appendCorrections(retracted);

    return { reopened, skipped };
}

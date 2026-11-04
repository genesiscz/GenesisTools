import { appendCorrections, type Correction } from "@genesiscz/utils/meetings/corrections";
import type { MeetingItem, MeetingRecord, MeetingStore } from "@genesiscz/utils/meetings/record";
import { questionIdOf, questionLabel } from "./questions";
import { TOOL } from "./shared";
import { ledgerEntryFor } from "./transcript-corrections";

/** What a confirm or reject did: the items it decided, and each one it left with the reason and how to decide it. */
export interface DecideResult {
    decided: string[];
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
    const ledger: Correction[] = [];
    await store.update(
        record.id,
        { command: status === "confirmed" ? "confirm" : "reject", change: deciding.map((item) => item.id).join(" ") },
        (current) => {
            for (const item of current.items) {
                if (!deciding.some((one) => one.id === item.id)) {
                    continue;
                }

                item.status = status;
                item.decidedAt = now;

                if (status !== "confirmed") {
                    continue;
                }

                if (item.kind === "speaker-range" && speaker) {
                    item.speaker = speaker;
                }

                if (item.kind === "term" && proposed) {
                    item.proposed = proposed;
                }

                const entry = ledgerEntryFor(current, item, now);

                if (entry) {
                    ledger.push(entry);
                }
            }
        }
    );
    appendCorrections(ledger);
    return { decided: deciding.map((item) => item.id), skipped };
}

/**
 * Puts decided items back to suggested: the Undo of a confirm or a reject. A question is never reopened here, because
 * its answer also decided other items; `listen` reopens its own answers. The corrections ledger is append-only, so a
 * confirm's ledger line stays; it counts as one confirmation for `dictionary suggest`.
 */
export async function reopenItems(options: {
    store: MeetingStore;
    record: MeetingRecord;
    ids: string[];
}): Promise<{ reopened: string[]; skipped: Array<{ id: string; reason: string }> }> {
    const { store } = options;
    // The saved record decides: the one passed in may be older than a confirm made since.
    const record = store.read(options.record.id) ?? options.record;
    const picked = pickItems(record, options.ids);
    const skipped = picked.flatMap((item) => {
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
    const reopening = picked.filter((item) => !skipped.some((skip) => skip.id === item.id)).map((item) => item.id);

    if (reopening.length > 0) {
        await store.update(record.id, { command: "reopen", change: reopening.join(" ") }, (current) => {
            for (const item of current.items) {
                if (reopening.includes(item.id)) {
                    item.status = "suggested";
                    delete item.decidedAt;
                }
            }
        });
    }

    return { reopened: reopening, skipped };
}

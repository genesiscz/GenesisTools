import { RangeStrength, rangeStrength } from "@genesiscz/utils/meetings/range-strength";
import type { MeetingItem, MeetingRecord, MeetingStore } from "@genesiscz/utils/meetings/record";
import { previewSuggestions } from "./suggest-run";

type SpeakerRange = Extract<MeetingItem, { kind: "speaker-range" }>;

/** The history change of `join --repair` that moved the later recordings' line addresses: it ends the stale window. */
export const LINE_ADDRESS_REPAIR = "line addresses of the later recordings moved onto the joined transcript's lines";

/** The history change of `join --repair` that judged the stale retirements again: written once, also when none came back. */
export const RETIREMENTS_JUDGED_AGAIN =
    "ranges a naming pass set aside for another line's speakers, judged again on their own line";

/** The retirement a naming pass gives a range that no person of its line can have said (`suggest.ts`). */
const ELIGIBILITY_RETIREMENT = "speaker-eligibility";

/**
 * The ids of the given ranges that a naming pass on their own lines keeps: it plans (never saves) a pass on a copy of
 * the record in which they are suggestions again. Tests pass a fake.
 */
export type RetirementJudge = (input: {
    store: MeetingStore;
    record: MeetingRecord;
    ids: readonly string[];
}) => Promise<ReadonlySet<string>>;

/**
 * The ranges a naming pass set aside by another line's speakers. A join before 2026-11-25 left a later recording's
 * line addresses on that recording's own lines; a pass between the join and the address repair judged such a range by
 * the line its stale address named on the joined transcript (a line of the first recording, or another line of its
 * own) and retired it for `speaker-eligibility` when nobody on that line could have said it. Each is a rule's range
 * on a later recording's line that nobody decided. Empty once the addresses are on the joined lines and the ranges
 * were judged again (`RETIREMENTS_JUDGED_AGAIN`), or when no pass ran while the addresses were stale. With
 * `linesPending` the address repair is still to come (a dry run), so the stale window is still open.
 */
export function staleRetirements(
    record: Pick<MeetingRecord, "join" | "items" | "history">,
    options: { linesPending?: boolean } = {}
): SpeakerRange[] {
    const join = record.join;

    if (!join || join.parts.some((part) => part.firstLine === undefined)) {
        return [];
    }

    const repaired = record.history.find(
        (event) => event.command === "join" && event.change.includes(LINE_ADDRESS_REPAIR)
    )?.at;
    const joinedAt = Date.parse(join.at);
    const end = options.linesPending || repaired === undefined ? Number.POSITIVE_INFINITY : Date.parse(repaired);

    if (!options.linesPending && repaired === undefined) {
        return [];
    }

    if (record.history.some((event) => event.command === "join" && event.change.includes(RETIREMENTS_JUDGED_AGAIN))) {
        return [];
    }

    const judgedStale = record.history.some(
        (event) => event.command === "suggest" && Date.parse(event.at) > joinedAt && Date.parse(event.at) < end
    );

    if (!judgedStale) {
        return [];
    }

    const firstLater = Math.min(...join.parts.slice(1).map((part) => part.firstLine!));
    return record.items.filter(
        (item): item is SpeakerRange =>
            item.kind === "speaker-range" &&
            item.status === "rejected" &&
            item.evidence?.retired === ELIGIBILITY_RETIREMENT &&
            !item.decision &&
            !item.decidedAt &&
            item.rules.length > 0 &&
            rangeStrength(item) === RangeStrength.Automatic &&
            typeof item.evidence.transcriptLine === "number" &&
            item.evidence.transcriptLine >= firstLater
    );
}

/** The record's items with the given retired ranges suggestions again, their retirement gone; the rest as they were. */
export function withRetirementsUndone(items: readonly MeetingItem[], ids: ReadonlySet<string>): MeetingItem[] {
    return items.map((item) => {
        if (!ids.has(item.id)) {
            return item;
        }

        const { retired: _retired, ...evidence } = item.evidence ?? {};
        return { ...item, status: "suggested", evidence };
    });
}

/** The default judge: a naming pass planned on the record's own lines, with every given range a suggestion again. */
export const plannedPassJudge: RetirementJudge = async ({ store, record, ids }) => {
    const asked = new Set(ids);
    const copy = { ...record, items: withRetirementsUndone(structuredClone(record.items), asked) };
    const { changes } = await previewSuggestions({ store, record: copy, rules: ["speakers", "evidence"] });
    const retired = new Set(
        changes.updated.flatMap(({ id, after }) => (asked.has(id) && after.status === "rejected" ? [id] : []))
    );
    return new Set(ids.filter((id) => !retired.has(id)));
};

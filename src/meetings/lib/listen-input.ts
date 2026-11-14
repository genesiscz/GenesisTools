import type { MeetingRecord } from "@genesiscz/utils/meetings/record";
import { prepareFindings } from "./add-findings";
import { type Finding, findingsFileSchema } from "./findings";
import { openQuestions, questionIdOf } from "./questions";

/** Ad-hoc questions use the same validation and persisted shape as items add. */
export function listenQuestionFindings(value: unknown): Finding[] {
    const findings = findingsFileSchema.parse(value);
    if (findings.length === 0 || findings.some((finding) => finding.kind !== "question")) {
        throw new Error("--questions needs a nonempty array of question findings");
    }
    return findings;
}

/** Resolve every requested question before a round writes anything. */
export function selectedQuestionIds(record: MeetingRecord, refs: readonly string[]): string[] {
    const open = new Set(openQuestions(record).map((question) => question.id));
    return [
        ...new Set(
            refs.map((ref) => {
                const id = questionIdOf(record, ref.trim());
                if (!id || !open.has(id)) {
                    throw new Error(`${ref} is not an open question in ${record.id}`);
                }
                return id;
            })
        ),
    ];
}

/**
 * The open questions an ad-hoc round asks: the item each submitted finding became, or the open one it repeats. Read
 * from the record after the add, the ids are the stored ones, not the ids a preparation hands out before it.
 */
export function roundQuestionIds(record: MeetingRecord, findings: Finding[]): string[] {
    const { added, duplicates } = prepareFindings({ findings, items: record.items });
    const open = new Set(openQuestions(record).map((question) => question.id));
    return [...new Set([...duplicates, ...added].map((item) => item.id).filter((id) => open.has(id)))];
}

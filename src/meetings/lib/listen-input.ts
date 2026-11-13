import type { MeetingRecord } from "@genesiscz/utils/meetings/record";
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

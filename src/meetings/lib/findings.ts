import { type MeetingItem, meetingItemSchema, nextId, QUESTION_TOPICS } from "@genesiscz/utils/meetings/record";
import { MeetingRule } from "@genesiscz/utils/meetings/rules";
import { parseClock } from "@genesiscz/utils/transcribe/render";
import { z } from "zod";

/** A transcript time: seconds, or "37:43" / "1:02:10". */
const clock = z.union([z.number().min(0), z.string()]).transform((value, ctx) => {
    const sec = typeof value === "number" ? value : parseClock(value);

    if (sec === undefined) {
        ctx.addIssue({ code: "custom", message: `"${value}" is not a transcript time (37:43, 1:02:10 or seconds)` });
        return z.NEVER;
    }

    return sec;
});
const confidence = z.number().min(0).max(1);
const text = z.string().trim().min(1);
const ids = z.array(z.string().regex(/^i\d+$/)).default([]);

/**
 * One finding to store, from `items add` flags or one entry of `--from-file`. A speaker range or a term is an
 * agent's judgement and needs a confidence and a reason; a question needs neither.
 */
export const findingSchema = z.discriminatedUnion("kind", [
    z.object({
        kind: z.literal("speaker-range"),
        from: clock,
        to: clock,
        /** The source's own label of the lines, as `evidence --raw` shows it. */
        label: text,
        speaker: text,
        confidence,
        reason: text,
    }),
    z.object({
        kind: z.literal("term"),
        at: clock,
        heard: text,
        proposed: text.optional(),
        /** Shown after the heard words, which stay: a spoken path's identifier. */
        meaning: text.optional(),
        /** The heard words read a document line aloud: its exact text and the source, shown instead of them. */
        quote: z.object({ text, source: text }).optional(),
        confidence,
        reason: text,
    }),
    z.object({
        kind: z.literal("question"),
        from: clock,
        to: clock,
        about: z.enum(QUESTION_TOPICS).default("speaker"),
        question: text,
        heard: text.optional(),
        choices: z.array(text).default([]),
        decides: ids,
        confidence: confidence.optional(),
        reason: text.optional(),
    }),
]);
export type Finding = z.output<typeof findingSchema>;
export const FINDING_KINDS = ["speaker-range", "term", "question"] as const;

/** A file of findings: an array, or `{ findings: [...] }`. */
export const findingsFileSchema = z.union([
    z.array(findingSchema),
    z.object({ findings: z.array(findingSchema) }).transform((file) => file.findings),
]);

/** Why a finding cannot go into this record, or undefined when it can. */
export function findingProblem(finding: Finding, items: MeetingItem[]): string | undefined {
    if ("from" in finding && finding.to < finding.from) {
        return `ends before it starts (${finding.from} > ${finding.to} s)`;
    }

    const missing =
        finding.kind === "question" ? finding.decides.filter((id) => !items.some((item) => item.id === id)) : [];
    return missing.length > 0 ? `decides ${missing.join(", ")}, which the meeting does not have` : undefined;
}

/** The items for some findings, with ids after the record's own. A finding with a reason is the agent's. */
export function findingItems(findings: Finding[], items: MeetingItem[], now: string): MeetingItem[] {
    const taken = [...items];

    return findings.map((finding) => {
        const by = finding.reason ? MeetingRule.Agent : MeetingRule.User;
        const base = {
            id: nextId("i", taken),
            status: "suggested",
            rules: [by],
            suggestedAt: now,
            ...(finding.confidence === undefined ? {} : { confidence: finding.confidence }),
            ...(finding.reason ? { evidence: { reason: finding.reason } } : {}),
        };
        const item = meetingItemSchema.parse(
            finding.kind === "speaker-range"
                ? {
                      ...base,
                      kind: finding.kind,
                      label: finding.label,
                      fromSec: finding.from,
                      toSec: finding.to,
                      speaker: finding.speaker,
                  }
                : finding.kind === "term"
                  ? {
                        ...base,
                        kind: finding.kind,
                        atSec: finding.at,
                        heard: finding.heard,
                        ...(finding.proposed ? { proposed: finding.proposed } : {}),
                        ...(finding.meaning ? { meaning: finding.meaning } : {}),
                        ...(finding.quote ? { quote: finding.quote } : {}),
                    }
                  : {
                        ...base,
                        kind: finding.kind,
                        about: finding.about,
                        fromSec: finding.from,
                        toSec: finding.to,
                        question: finding.question,
                        ...(finding.heard ? { heard: finding.heard } : {}),
                        choices: finding.choices,
                        decides: finding.decides,
                    }
        );
        taken.push(item);
        return item;
    });
}

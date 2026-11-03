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
/** A line's index in the source transcript: tells apart two lines that start in the same second. */
const line = z.number().int().min(0).optional();
/** A name for a finding that a question in the same batch can list in `decides`, before the finding has an id. */
const ref = z
    .string()
    .trim()
    .regex(/^(?!i\d+$)[\w-]+$/, "a ref is letters, digits, - or _, and never an item id such as i3")
    .optional();

/**
 * One finding to store, from `items add` flags or one entry of `--from-file`. A speaker range, a join or a term is an
 * agent's judgement and needs a confidence and a reason; a label that tracks no one person needs a reason; a question
 * needs neither.
 */
export const findingSchema = z.discriminatedUnion("kind", [
    z.object({
        kind: z.literal("speaker-range"),
        ref,
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
        ref,
        at: clock,
        line,
        heard: text,
        proposed: text.optional(),
        /** `line`: `proposed` fixes only the line at `at`. The default fixes the words wherever they are heard. */
        scope: z.enum(["everywhere", "line"]).optional(),
        /** Shown after the heard words, which stay: a spoken path's identifier. */
        meaning: text.optional(),
        /** The heard words read a document line aloud: its exact text and the source, shown instead of them. */
        quote: z.object({ text, source: text }).optional(),
        confidence,
        reason: text,
    }),
    z.object({
        kind: z.literal("join"),
        ref,
        /** The start of the line after the cut, whose first word ends the word cut in the line before. */
        at: clock,
        line,
        /** The source's label whose voice speaks the joined line. Absent, the label of the line after the cut. */
        label: text.optional(),
        /** The whole word, as the joined line shows it. */
        joined: text.optional(),
        confidence,
        reason: text,
    }),
    z.object({
        kind: z.literal("label"),
        ref,
        from: clock,
        to: clock,
        /** The source's own label that does not track one person from `from` to `to`. */
        label: text,
        meaningless: z.literal(true),
        confidence: confidence.optional(),
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
        /** Item ids (`i3`) or the refs of findings in the same batch. */
        decides: z.array(z.string().trim().min(1)).default([]),
        /**
         * The scale suggest uses: (1 − confidence) × impact × reach, about 1 to 3 for one question and 6 or more for a
         * cluster. Listen asks the highest first, and one under `playback.listen.minPriority` (0.5) only with `--item`.
         */
        priority: z.number().min(0).optional(),
        confidence: confidence.optional(),
        reason: text.optional(),
    }),
]);
export type Finding = z.output<typeof findingSchema>;
export const FINDING_KINDS = ["speaker-range", "label", "join", "term", "question"] as const;

/** A file of findings: an array, or `{ findings: [...] }`. */
export const findingsFileSchema = z.union([
    z.array(findingSchema),
    z.object({ findings: z.array(findingSchema) }).transform((file) => file.findings),
]);

/** Why a batch of findings cannot go into this record, one line per finding; empty when it can. */
export function findingProblems(findings: Finding[], items: MeetingItem[]): string[] {
    const refs = findings.flatMap((finding) => ("ref" in finding && finding.ref ? [finding.ref] : []));
    const twice = new Set(refs.filter((name, index) => refs.indexOf(name) !== index));

    return findings.flatMap((finding, index) => {
        const problem = findingProblem(finding, items, new Set(refs), twice);
        return problem ? [`#${index + 1} (${finding.kind}) ${problem}`] : [];
    });
}

function findingProblem(
    finding: Finding,
    items: MeetingItem[],
    refs: Set<string>,
    twice: Set<string>
): string | undefined {
    if ("from" in finding && finding.to < finding.from) {
        return `ends before it starts (${finding.from} > ${finding.to} s)`;
    }

    if ("ref" in finding && finding.ref && twice.has(finding.ref)) {
        return `ref "${finding.ref}" names more than one finding`;
    }

    const missing =
        finding.kind === "question"
            ? finding.decides.filter((id) => !refs.has(id) && !items.some((item) => item.id === id))
            : [];
    return missing.length > 0
        ? `decides ${missing.join(", ")}, which neither the meeting nor this batch has`
        : undefined;
}

/**
 * The items for some findings, with ids after the record's own. A finding with a reason is the agent's. A question's
 * `decides` may name the refs of findings in the same batch: they become those findings' new ids.
 */
export function findingItems(findings: Finding[], items: MeetingItem[], now: string): MeetingItem[] {
    const taken: Array<{ id: string }> = [...items];
    const newIds = findings.map(() => {
        const id = nextId("i", taken);
        taken.push({ id });
        return id;
    });
    const idOfRef = new Map(
        findings.flatMap((finding, index) => ("ref" in finding && finding.ref ? [[finding.ref, newIds[index]!]] : []))
    );

    return findings.map((finding, index) => {
        const by = finding.reason ? MeetingRule.Agent : MeetingRule.User;
        const base = {
            id: newIds[index],
            status: "suggested",
            rules: [by],
            suggestedAt: now,
            ...(finding.confidence === undefined ? {} : { confidence: finding.confidence }),
        };
        const evidence = {
            ...(finding.reason ? { reason: finding.reason } : {}),
            ...("line" in finding && finding.line !== undefined ? { transcriptLine: finding.line } : {}),
        };

        return meetingItemSchema.parse({
            ...base,
            ...(Object.keys(evidence).length > 0 ? { evidence } : {}),
            ...kindFields(finding, idOfRef),
        });
    });
}

/** A finding's own fields, in the record's names. */
function kindFields(finding: Finding, idOfRef: Map<string, string>): Record<string, unknown> {
    if (finding.kind === "speaker-range") {
        return {
            kind: finding.kind,
            label: finding.label,
            fromSec: finding.from,
            toSec: finding.to,
            speaker: finding.speaker,
        };
    }

    if (finding.kind === "label") {
        return {
            kind: finding.kind,
            label: finding.label,
            fromSec: finding.from,
            toSec: finding.to,
            meaningless: true,
        };
    }

    if (finding.kind === "join") {
        return {
            kind: finding.kind,
            atSec: finding.at,
            ...(finding.label ? { speaker: finding.label } : {}),
            ...(finding.joined ? { joined: finding.joined } : {}),
        };
    }

    if (finding.kind === "term") {
        return {
            kind: finding.kind,
            atSec: finding.at,
            heard: finding.heard,
            ...(finding.proposed ? { proposed: finding.proposed } : {}),
            ...(finding.scope === "line" ? { scope: finding.scope } : {}),
            ...(finding.meaning ? { meaning: finding.meaning } : {}),
            ...(finding.quote ? { quote: finding.quote } : {}),
        };
    }

    return {
        kind: finding.kind,
        about: finding.about,
        fromSec: finding.from,
        toSec: finding.to,
        question: finding.question,
        ...(finding.heard ? { heard: finding.heard } : {}),
        choices: finding.choices,
        decides: finding.decides.map((id) => idOfRef.get(id) ?? id),
        ...(finding.priority === undefined ? {} : { priority: finding.priority }),
    };
}

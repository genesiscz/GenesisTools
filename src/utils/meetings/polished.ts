import { z } from "zod";

/**
 * The authored half of a meeting's polished file (plugins/genesis-tools/skills/meetings/references/polishing.md). One
 * `<name>.polished.ts` beside the polished markdown holds only `export default defineMeetingsPolished({ … })`; an agent
 * edits it, and `tools meetings polish build <file>` writes the markdown from it and the live meeting records. The
 * build never writes this file.
 *
 * Outside this repository the import resolves after `tools link install` (the json2md document pattern).
 */
export const MEETINGS_POLISHED_SPECIFIER = "@genesiscz/utils/meetings/polished";

/** The generated sections, in the order the file shows them; an extra section names one of them as `after`. */
export const POLISHED_SECTIONS = [
    "participants",
    "glossary",
    "references",
    "summary",
    "transcript",
    "diffs",
    "unresolved",
    "questions",
] as const;
export type PolishedSection = (typeof POLISHED_SECTIONS)[number];

/** One source's facts for a part, keyed by source id as the record keeps its own `sources` (wisprflow, …). */
const partSourceSchema = z
    .object({
        meetingId: z.string().min(1).optional(),
        shareLink: z.string().min(1).optional(),
    })
    .strict();

/** One recording of the meeting: one record. A polished file holds one or more. */
const partSchema = z
    .object({
        /** The meeting record id. */
        record: z.string().min(1),
        /** `[[<token>:MM:SS]]` in authored text plays this record at that time (`t`, `p`). */
        token: z.string().regex(/^[a-z]+$/, "a token is lower-case letters, such as t or p"),
        /**
         * Written before a time of this part where a link cannot go (inside a diff block) and after an unresolved
         * entry's time, so a reader knows which recording it is in. Unset: the time stands alone.
         */
        marker: z.string().min(1).optional(),
        /** Local `YYYY-MM-DD HH:MM`; default the record's own start and end. */
        start: z.string().min(1).optional(),
        end: z.string().min(1).optional(),
        /** The untouched raw export of this part, relative to the polished file. */
        rawExport: z.string().min(1).optional(),
        sources: z.record(z.string(), partSourceSchema).optional(),
    })
    .strict();

/** An authored markdown section. `[[<token>:MM:SS]]` becomes a play link, and plain text inside a code fence. */
const sectionTextSchema = z
    .object({
        md: z.string(),
        /**
         * Also link bare `MM:SS` times on its bullet lines: to this part token, or to the part whose `marker` stands
         * right before the time.
         */
        linkBareTimes: z.string().optional(),
    })
    .strict();

const extraSectionSchema = z
    .object({
        heading: z.string().min(1),
        after: z.enum(POLISHED_SECTIONS),
        intro: z.string().optional(),
        md: z.string(),
    })
    .strict();

/** What the screen record says about an unresolved reading. */
const screenSchema = z
    .object({
        resolved: z.boolean(),
        /** The fix is stored in the record already: the entry shows as settled. */
        stored: z.boolean().optional(),
        proposed: z.string().nullable().optional(),
        confidence: z.number().nullable().optional(),
        frame: z.string().nullable().optional(),
        ocr: z.string().nullable().optional(),
        reason: z.string().optional(),
    })
    .strict();

/**
 * One `U<n>` entry: heard words with their sentence (the last reading offered is "something else"), or a free question
 * (the last reading offered is "someone else"). `elseReading` replaces that last reading.
 */
const unresolvedSchema = z
    .object({
        id: z.string().min(1),
        record: z.string().min(1),
        at: z.string().min(1),
        heard: z.string().min(1).optional(),
        sentence: z.string().min(1).optional(),
        question: z.string().min(1).optional(),
        readings: z.array(z.string()).default([]),
        elseReading: z.string().min(1).optional(),
        screen: screenSchema.nullable().optional(),
        /** The listen question that asks it, `Q23`. */
        listen: z.string().min(1).optional(),
    })
    .strict()
    .refine((entry) => entry.question !== undefined || (entry.heard !== undefined && entry.sentence !== undefined), {
        message: "an unresolved entry needs heard and sentence, or a question",
    });

/**
 * The fixed sentences the build writes. `{name}` is filled in. A key left out comes from the meeting language's
 * `languages.<code>.render.polished` in the meetings config ({@link POLISHED_PHRASES_BY_LANGUAGE} ships cs, sk and en).
 */
const phrasesSchema = z
    .object({
        /** The transcript source's name in the speaker diff (`[Wispr: Me]`); default the source's own label. */
        sourceLabel: z.string().min(1).optional(),
        somethingElse: z.string().min(1).optional(),
        someoneElse: z.string().min(1).optional(),
        /** {proposed} {confidence} {frame} {ocr} */
        screenSettled: z.string().min(1).optional(),
        /** {proposed} {confidence} {frame} {ocr} {reason} */
        screenHint: z.string().min(1).optional(),
        /** {reason} */
        screenUndecided: z.string().min(1).optional(),
        /** The speaker diff's reason for a confirmed line that records none. */
        confirmed: z.string().min(1).optional(),
    })
    .strict();

/** The phrases that belong to a language: every phrase except the source's name. */
export type PolishedLanguagePhrases = Omit<PolishedPhrases, "sourceLabel">;

/** The English phrases: the shipped `en`, and the phrases of a language whose block sets none. */
export const DEFAULT_POLISHED_PHRASES: PolishedLanguagePhrases = {
    somethingElse: "something else",
    someoneElse: "someone else",
    screenSettled:
        "✅ Settled by the screen: **{proposed}** ({confidence}). Frame {frame}: „{ocr}“. The fix is in the record.",
    screenHint: "🖥️ The screen suggests **{proposed}** ({confidence}): frame {frame}, „{ocr}“. {reason}",
    screenUndecided: "The screen does not decide: {reason}",
    confirmed: "confirmed",
};

/**
 * The shipped phrases per meeting language code: the defaults of `languages.<code>.render.polished` in the meetings
 * config. A language with no entry gets the English ones.
 */
export const POLISHED_PHRASES_BY_LANGUAGE: Readonly<Record<string, PolishedLanguagePhrases>> = {
    en: DEFAULT_POLISHED_PHRASES,
    cs: {
        somethingElse: "něco jiného",
        someoneElse: "někdo jiný",
        screenSettled:
            "✅ Vyřešeno podle obrazovky: **{proposed}** ({confidence}). Snímek {frame}: „{ocr}“. Oprava je v záznamu.",
        screenHint: "🖥️ Obrazovka naznačuje **{proposed}** ({confidence}): snímek {frame}, „{ocr}“. {reason}",
        screenUndecided: "Obrazovka nerozhodne: {reason}",
        confirmed: "potvrzeno",
    },
    sk: {
        somethingElse: "niečo iné",
        someoneElse: "niekto iný",
        screenSettled:
            "✅ Vyriešené podľa obrazovky: **{proposed}** ({confidence}). Snímka {frame}: „{ocr}“. Oprava je v zázname.",
        screenHint: "🖥️ Obrazovka naznačuje **{proposed}** ({confidence}): snímka {frame}, „{ocr}“. {reason}",
        screenUndecided: "Obrazovka nerozhodne: {reason}",
        confirmed: "potvrdené",
    },
};

export const meetingsPolishedSchema = z
    .object({
        /** The front matter title; the heading adds " (polished)" unless `heading` says otherwise. */
        title: z.string().min(1),
        heading: z.string().min(1).optional(),
        /** Output markdown, relative to this file; default this file's name with `.md`. */
        out: z.string().min(1).optional(),
        status: z.string().min(1).optional(),
        private: z.boolean().optional(),
        /** Local `YYYY-MM-DD HH:MM`. */
        writtenAt: z.string().min(1).optional(),
        updatedAt: z.string().min(1).optional(),
        /** More front matter keys (tags, a work item); a key the build writes too is replaced by this one. */
        frontmatter: z.record(z.string(), z.unknown()).optional(),
        parts: z.array(partSchema).min(1),
        /** Markdown under the heading, before the updates. */
        intro: z.string().optional(),
        updates: z.array(z.object({ at: z.string().min(1), text: z.string().min(1) }).strict()).optional(),
        /** Markdown after the updates. */
        introTail: z.string().optional(),
        participants: z
            .array(
                z
                    .object({
                        person: z.string().min(1),
                        role: z.string(),
                        seat: z.string(),
                        present: z.string(),
                    })
                    .strict()
            )
            .optional(),
        namedNotPresent: z.string().optional(),
        /** Rows of the label map; without them the build lists the records' meaningless-label items. */
        labelMap: z
            .array(
                z
                    .object({
                        record: z.string().min(1),
                        rawLabel: z.string().min(1),
                        person: z.string(),
                        range: z.string(),
                        evidence: z.string(),
                    })
                    .strict()
            )
            .optional(),
        glossary: sectionTextSchema.optional(),
        references: sectionTextSchema.optional(),
        summary: sectionTextSchema.optional(),
        summaryDiff: sectionTextSchema.optional(),
        sections: z.array(extraSectionSchema).optional(),
        unresolved: z.array(unresolvedSchema).optional(),
        /** A note after the given words in one record's transcript: `text <sup>(note)</sup>`. */
        transcriptMarks: z
            .array(z.object({ record: z.string().min(1), text: z.string().min(1), note: z.string().min(1) }).strict())
            .optional(),
        openQuestions: z
            .object({
                /** Markdown after the generated "By ear" line. */
                intro: z.string().optional(),
            })
            .strict()
            .optional(),
        transcript: z
            .object({
                /** Apply suggestions at or above this percentage; lower speaker guesses show as `[Name: NN %]`. */
                applyAbove: z.number().min(0).max(100).default(70),
                withSuggested: z.boolean().default(true),
                dictionary: z.boolean().optional(),
            })
            .strict()
            .default({ applyAbove: 70, withSuggested: true }),
        /**
         * The meeting's language code: the phrases of its `languages.<code>` block in the meetings config fill the
         * `phrases` this file leaves out. Default: the config's `global.language`.
         */
        language: z.string().trim().min(1).optional(),
        phrases: phrasesSchema.optional(),
        overrides: z
            .object({
                /**
                 * Replaces a generated section's whole body (the heading stays); null leaves the section out, as a
                 * hand-written file adopted by `polish init` that never had it.
                 */
                sections: z.partialRecord(z.enum(POLISHED_SECTIONS), z.string().nullable()).optional(),
                /** Replaces one open question's text, keyed `<record>#Q<n>`. */
                questions: z.record(z.string(), z.string()).optional(),
            })
            .strict()
            .optional(),
        /** Fields kept from an adopted draft that the build does not read; never rendered. */
        extras: z.record(z.string(), z.unknown()).optional(),
    })
    .strict()
    .superRefine((config, ctx) => {
        const records = new Set(config.parts.map((part) => part.record));
        const tokens = new Set<string>();

        for (const [index, part] of config.parts.entries()) {
            if (tokens.has(part.token)) {
                ctx.addIssue({
                    code: "custom",
                    path: ["parts", index, "token"],
                    message: `token "${part.token}" is used twice`,
                });
            }

            tokens.add(part.token);
        }

        const named = [
            ...(config.labelMap ?? []).map((row, index) => ({
                record: row.record,
                path: ["labelMap", index, "record"],
            })),
            ...(config.unresolved ?? []).map((row, index) => ({
                record: row.record,
                path: ["unresolved", index, "record"],
            })),
            ...(config.transcriptMarks ?? []).map((row, index) => ({
                record: row.record,
                path: ["transcriptMarks", index, "record"],
            })),
        ];

        for (const { record, path } of named) {
            if (!records.has(record)) {
                ctx.addIssue({ code: "custom", path, message: `"${record}" is not the record of any part` });
            }
        }
    });

/** What an agent writes: defaults may be left out. */
export type MeetingsPolishedInput = z.input<typeof meetingsPolishedSchema>;
/** What the build reads: defaults filled in. */
export type MeetingsPolishedConfig = z.output<typeof meetingsPolishedSchema>;
export type PolishedPart = MeetingsPolishedConfig["parts"][number];
export type PolishedUnresolved = NonNullable<MeetingsPolishedConfig["unresolved"]>[number];
export type PolishedPhrases = Required<z.output<typeof phrasesSchema>>;

const MARKER = Symbol.for("genesiscz.meetings.polished");

export type DefinedMeetingsPolished = MeetingsPolishedConfig & { readonly [MARKER]: true };

/**
 * Declares a meeting's polished file. Validated here, not only in the build, because the module is loaded by dynamic
 * import and nothing typechecks it at the moment it matters: `bun file.ts` reports a mistake too.
 */
export function defineMeetingsPolished(input: MeetingsPolishedInput): DefinedMeetingsPolished {
    const parsed = meetingsPolishedSchema.safeParse(input);

    if (!parsed.success) {
        throw new Error(`defineMeetingsPolished: ${z.prettifyError(parsed.error)}`);
    }

    return { ...parsed.data, [MARKER]: true };
}

export function isDefinedMeetingsPolished(value: unknown): value is DefinedMeetingsPolished {
    return typeof value === "object" && value !== null && MARKER in value;
}

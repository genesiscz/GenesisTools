import { ABBR_EXPANSIONS, dictionaryEntrySchema } from "@genesiscz/utils/transcribe/dictionary";
import { z } from "zod";
import type { PhraseTest } from "./dictionary-test";
import type { MatchPreviewRow } from "./match-preview";
import type { ProjectRemoval, ProjectRename } from "./project-admin";
import type { ProjectSuggestions } from "./project-suggestions";
import type { DictionaryShowView } from "./window-reads";

/**
 * The shapes of the meetings library (the known projects, the dictionary, the source rules) as the Meetings service
 * answers them (decision 13): the settings page reads and writes them through the service, and `tools meetings
 * projects`, `dictionary` and `config edit` print the same values. Kept apart from the libraries that make them, so the
 * service's descriptor (service/api.ts, which every `tools meetings` read imports) loads only zod and the dictionary
 * schema the record already loads.
 */

/** A meeting against the saved project rules and a draft of them (`projects preview --json`). */
export const matchPreviewRowSchema = z.object({
    id: z.string(),
    title: z.string(),
    start: z.string(),
    /** The project the meeting has now, set by a rule, an answer or a person. */
    project: z.string().optional(),
    /** The projects the saved rules match. */
    now: z.array(z.string()),
    /** The projects the draft rules match; equal to `now` without a draft. */
    draft: z.array(z.string()),
    changed: z.boolean(),
}) satisfies z.ZodType<MatchPreviewRow>;

/** A dictionary entry with the level it comes from: `global` or `project <name>`. */
const leveledEntrySchema = z.intersection(dictionaryEntrySchema, z.object({ level: z.string() }));

/** The merged dictionary of a scope (`dictionary show --json`). */
export const dictionaryShowSchema = z.object({
    /** The project whose entries are merged over the global ones; null for the global dictionary alone. */
    project: z.string().nullable(),
    abbrExpansion: z.enum(ABBR_EXPANSIONS),
    entries: z.array(leveledEntrySchema),
}) satisfies z.ZodType<DictionaryShowView>;

/** What a scope's dictionary does to one phrase (`dictionary test --json`). */
export const phraseTestSchema = z.object({
    phrase: z.string(),
    /** The phrase after the whole dictionary of the scope, as a transcript line would read. */
    text: z.string(),
    /** The entries that change the phrase on their own, in dictionary order. */
    fired: z.array(dictionaryEntrySchema),
    /** Words close to a term that a transcript would mark for a person to decide, with the score. */
    suggestions: z.array(z.object({ heard: z.string(), value: z.string(), score: z.number() })),
    counts: z.object({
        fixes: z.number(),
        spoken: z.number(),
        fuzzy: z.number(),
        expansions: z.number(),
        meanings: z.number(),
    }),
}) satisfies z.ZodType<PhraseTest>;

/** A project renamed everywhere it is named (`projects rename --json`). */
export const projectRenameSchema = z.object({
    from: z.string(),
    to: z.string(),
    /** The meetings whose project changed with it. */
    meetings: z.array(z.string()),
}) satisfies z.ZodType<ProjectRename>;

/** A removed project (`projects remove --json`). */
export const projectRemovalSchema = z.object({
    name: z.string(),
    /** The meetings that had the project and now have none (`unassign`). */
    unassigned: z.array(z.string()),
    /** The file that keeps the removed block and its source pairings. */
    backup: z.string(),
}) satisfies z.ZodType<ProjectRemoval>;

/** A person as a project pairing names one: a name, and the address when it is known. */
export const pairedPersonRefSchema = z.object({ name: z.string(), email: z.string().optional() });

/** The values the settings page's rule fields offer (`projects.suggestions`). */
export const projectSuggestionsSchema = z.object({
    /** Per source: its folders, from its own list or from the folders its meetings sit in. */
    folders: z.record(
        z.string(),
        z.object({ values: z.array(z.string()), from: z.enum(["source", "meetings"]), reason: z.string().optional() })
    ),
    calendars: z.object({ values: z.array(z.string()), reason: z.string().optional() }),
    titleWords: z.array(z.string()),
    labels: z.array(z.string()),
}) satisfies z.ZodType<ProjectSuggestions>;

/** One pairing an unpair removed. `left`: the person is no longer paired with the project at all. */
export const unpairedSchema = z.object({
    project: z.string(),
    name: z.string(),
    email: z.string().optional(),
    left: z.boolean(),
});

/** One change of a config edit: a value to write, or `unset` to remove the key so its default applies again. */
export const configEditSchema = z.union([
    z.object({ path: z.string().min(1), value: z.unknown(), expect: z.unknown().optional() }).strict(),
    z.object({ path: z.string().min(1), unset: z.literal(true), expect: z.unknown().optional() }).strict(),
]);

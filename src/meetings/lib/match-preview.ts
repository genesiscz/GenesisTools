import { type MeetingsConfig, matchProjects } from "@genesiscz/utils/meetings/config";
import type { MeetingRecord } from "@genesiscz/utils/meetings/record";
import { MEETING_SOURCE_IDS, type MeetingSourceId } from "@genesiscz/utils/meetings/sources";
import { z } from "zod";

/** The match rules of some projects as a person is editing them, before anything is saved. */
export const matchDraftSchema = z.record(
    z.string().min(1),
    z
        .object({
            /** Per source, the folders that put a meeting in the project. */
            folders: z.record(z.string(), z.array(z.string())).optional(),
            calendars: z.array(z.string()).optional(),
            titleWords: z.array(z.string()).optional(),
        })
        .strict()
);
export type MatchDraft = z.infer<typeof matchDraftSchema>;

export interface MatchPreviewRow {
    id: string;
    title: string;
    start: string;
    /** The project the meeting has now, set by a rule, an answer or a person. */
    project?: string;
    /** The projects the saved rules match. */
    now: string[];
    /** The projects the draft rules match; equal to `now` without a draft. */
    draft: string[];
    changed: boolean;
}

function isSourceId(id: string): id is MeetingSourceId {
    return (MEETING_SOURCE_IDS as readonly string[]).includes(id);
}

/** The config with the draft's rules in place of the saved ones, for the projects the draft names. */
export function withDraft(config: MeetingsConfig, draft: MatchDraft): MeetingsConfig {
    const copy = structuredClone(config);

    for (const [name, rules] of Object.entries(draft)) {
        const project = copy.projects[name] ?? { labels: [] };
        const match = project.match ?? { people: [] };

        if (rules.calendars) {
            match.calendar = { calendars: rules.calendars };
        }

        if (rules.titleWords) {
            match.title = { words: rules.titleWords };
        }

        project.match = match;
        copy.projects[name] = project;

        for (const [source, folders] of Object.entries(rules.folders ?? {})) {
            if (isSourceId(source)) {
                copy.sources[source].match[name] = { folders };
            }
        }
    }

    return copy;
}

/** The facts the match rules read from a record: its title, its calendar's name and each source's folders. */
function factsOf(record: MeetingRecord, source: MeetingSourceId | undefined) {
    const block = source ? record.sources[source] : undefined;
    const folders = Array.isArray(block?.folders)
        ? block.folders.filter((folder): folder is string => typeof folder === "string")
        : [];

    return {
        title: record.title,
        ...(record.calendar?.calendar ? { calendar: record.calendar.calendar } : {}),
        ...(source ? { source: { id: source, folders } } : {}),
    };
}

/**
 * Which projects the newest `limit` meetings match with the saved rules and with the draft. A meeting linked to
 * several sources is matched once per source. Reads only.
 */
export function matchPreview(options: {
    records: MeetingRecord[];
    config: MeetingsConfig;
    draft?: MatchDraft;
    limit: number;
}): MatchPreviewRow[] {
    const drafted = options.draft ? withDraft(options.config, options.draft) : options.config;
    const matches = (config: MeetingsConfig, record: MeetingRecord): string[] => {
        const sources = Object.keys(record.sources).filter(isSourceId);
        const names = (sources.length > 0 ? sources : [undefined]).flatMap((source) =>
            matchProjects(config, factsOf(record, source))
        );
        return [...new Set(names)];
    };

    return [...options.records]
        .sort((a, b) => Date.parse(b.start) - Date.parse(a.start))
        .slice(0, options.limit)
        .map((record) => {
            const now = matches(options.config, record);
            const draft = matches(drafted, record);

            return {
                id: record.id,
                title: record.title,
                start: record.start,
                ...(record.project ? { project: record.project } : {}),
                now,
                draft,
                changed: now.join("\n") !== draft.join("\n"),
            };
        });
}

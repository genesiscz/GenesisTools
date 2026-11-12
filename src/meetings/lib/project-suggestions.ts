import { logger } from "@genesiscz/utils/logger";
import type { MeetingsConfig } from "@genesiscz/utils/meetings/config";
import type { MeetingRecord } from "@genesiscz/utils/meetings/record";
import { MEETING_SOURCE_IDS, type MeetingSourceId } from "@genesiscz/utils/meetings/sources";

const { log } = logger.scoped("meetings-project-suggestions");

/**
 * The values the settings page offers while a person types a project's rules: what a field can hold that the system
 * already knows. Each list may be empty; a read that failed says why in `reason`, so the field can tell an empty list
 * from a read it could not make.
 */
export interface ProjectSuggestions {
    /** Per source, its folders: its own list with the folders its meetings sit in (`from: "source"`), or only the latter when it keeps no list. */
    folders: Record<MeetingSourceId, { values: string[]; from: "source" | "meetings"; reason?: string }>;
    /** The calendars of the Calendar app, then the ones the meetings and the rules name. */
    calendars: { values: string[]; reason?: string };
    /** The title words the rules use, then the words most frequent in meeting titles. */
    titleWords: string[];
    /** The labels of every project and meeting. */
    labels: string[];
}

/** What the suggestions read outside the config and the records; a test passes its own. */
export interface SuggestionReads {
    /** A source's folders; null when it keeps none on this Mac. */
    sourceFolders: (source: MeetingSourceId) => Promise<string[] | null>;
    /** The Calendar app's calendar names, or why they cannot be read (no grant, no macOS). */
    calendarNames: () => Promise<{ names: string[] } | { reason: string }>;
}

/** Words of a title that make a rule: letters or digits, three or more, not only digits. */
const STOP_WORDS = new Set(["the", "and", "for", "with", "meeting", "call", "sync", "daily", "weekly"]);
const TITLE_WORD_LIMIT = 60;

function unique(values: Iterable<string>): string[] {
    const seen = new Set<string>();
    const out: string[] = [];

    for (const raw of values) {
        const value = raw.trim();
        const key = value.toLowerCase();

        if (value && !seen.has(key)) {
            seen.add(key);
            out.push(value);
        }
    }

    return out;
}

function byName(values: string[]): string[] {
    return [...values].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

/** The folder names a record's source block holds (`sources.<id>.folders`). */
function recordFolders(record: MeetingRecord, source: MeetingSourceId): string[] {
    const folders = record.sources[source]?.folders;
    return Array.isArray(folders) ? folders.filter((name): name is string => typeof name === "string") : [];
}

export function frequentTitleWords(records: MeetingRecord[], limit = TITLE_WORD_LIMIT): string[] {
    const counts = new Map<string, { word: string; count: number }>();

    for (const record of records) {
        const words = record.title.match(/[\p{L}\p{N}][\p{L}\p{N}._-]*/gu) ?? [];

        for (const word of new Set(words)) {
            const key = word.toLowerCase();

            if (word.length < 3 || /^\d+$/.test(word) || STOP_WORDS.has(key)) {
                continue;
            }

            const known = counts.get(key);
            counts.set(key, { word: known?.word ?? word, count: (known?.count ?? 0) + 1 });
        }
    }

    return [...counts.values()]
        .sort((a, b) => b.count - a.count || a.word.localeCompare(b.word))
        .slice(0, limit)
        .map((entry) => entry.word);
}

/** The values each rule field of the settings page offers. Reads only. */
export async function projectSuggestions(options: {
    records: MeetingRecord[];
    config: MeetingsConfig;
    reads: SuggestionReads;
}): Promise<ProjectSuggestions> {
    const { records, config, reads } = options;
    const folders = {} as ProjectSuggestions["folders"];

    for (const source of MEETING_SOURCE_IDS) {
        const ruled = Object.values(config.sources[source]?.match ?? {}).flatMap((match) => match?.folders ?? []);
        const fromMeetings = records.flatMap((record) => recordFolders(record, source));
        const own = await reads.sourceFolders(source).catch((err: unknown) => {
            log.warn({ err, source }, "the source's folders could not be read");
            return null;
        });
        folders[source] = own
            ? { values: byName(unique([...own, ...fromMeetings, ...ruled])), from: "source" }
            : {
                  values: byName(unique([...fromMeetings, ...ruled])),
                  from: "meetings",
                  reason: `${source} keeps no folder list on this Mac, so these are the folders its meetings sit in`,
              };
    }

    const ruledCalendars = Object.values(config.projects).flatMap(
        (project) => project.match?.calendar?.calendars ?? []
    );
    const meetingCalendars = records.flatMap((record) => (record.calendar?.calendar ? [record.calendar.calendar] : []));
    const app = await reads.calendarNames().catch((err: unknown) => ({
        reason: `The Calendar app's calendars could not be read: ${err instanceof Error ? err.message : String(err)}`,
    }));
    const calendars =
        "names" in app
            ? { values: unique([...byName(app.names), ...byName(unique([...meetingCalendars, ...ruledCalendars]))]) }
            : { values: byName(unique([...meetingCalendars, ...ruledCalendars])), reason: app.reason };

    const ruledWords = Object.values(config.projects).flatMap((project) => project.match?.title?.words ?? []);
    const labels = [
        ...Object.values(config.projects).flatMap((project) => project.labels),
        ...records.flatMap((record) => record.labels),
    ];

    return {
        folders,
        calendars,
        titleWords: unique([...byName(unique(ruledWords)), ...frequentTitleWords(records)]),
        labels: byName(unique(labels)),
    };
}

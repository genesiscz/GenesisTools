import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { logger } from "@genesiscz/utils/logger";
import type { MeetingsConfigStore } from "@genesiscz/utils/meetings/config";
import {
    type MeetingCreator,
    type MeetingParticipant,
    type MeetingRecord,
    type MeetingStore,
    parseSourceRef,
} from "@genesiscz/utils/meetings/record";
import type { SourceMeeting } from "@genesiscz/utils/meetings/sources";
import { resolveProject } from "./project";
import { meetingSource } from "./sources";

const { log } = logger.scoped("meetings-link");

/** People from the source join the record's list; a name already there gains the source in `from`. */
function mergeParticipants(current: MeetingParticipant[], incoming: MeetingParticipant[]): MeetingParticipant[] {
    const merged = current.map((person) => ({ ...person, from: [...person.from] }));

    for (const person of incoming) {
        const known = merged.find((existing) => existing.name === person.name);

        if (!known) {
            merged.push(person);
            continue;
        }

        known.from = [...new Set([...known.from, ...person.from])];
        known.self ||= person.self;
    }

    return merged;
}

/**
 * The source fills what the record does not have. With `refresh` (the source ended a meeting it was live for) its title
 * and end win, unless a person gave the record its title.
 */
function applySource(options: {
    record: MeetingRecord;
    sourceId: string;
    block: Record<string, unknown>;
    meeting: SourceMeeting;
    refresh?: boolean;
}): void {
    const { record, meeting } = options;
    const titledByHand = record.history.some((entry) => entry.command === "set" && entry.change.includes(`title "`));
    record.sources[options.sourceId] = options.block;
    record.title =
        options.refresh && meeting.title.trim() && !titledByHand ? meeting.title : record.title || meeting.title;
    record.end = options.refresh ? (meeting.end ?? record.end) : (record.end ?? meeting.end);
    record.participants = mergeParticipants(record.participants, meeting.participants);
    record.calendar ??= meeting.calendar;
}

export interface LinkResult {
    record: MeetingRecord;
    created: boolean;
}

/**
 * Attaches a source's meeting (`wisprflow:<id>`) to a meeting record: the record named by `meetingRef`, the one
 * already linked to that source meeting, or a new one. The source fills what the record does not have yet.
 */
export async function linkSource(options: {
    store: MeetingStore;
    config: MeetingsConfigStore;
    sourceRef: string;
    meetingRef?: string;
    project?: string;
    command: string;
    createdBy: MeetingCreator;
    quiet?: boolean;
    /** The source ended the meeting: its title and end replace those it had while live. */
    refresh?: boolean;
}): Promise<LinkResult> {
    const ref = parseSourceRef(options.sourceRef);

    if (!ref) {
        throw new Error(`"${options.sourceRef}" is not a source reference; write it as wisprflow:<meeting id>`);
    }

    const source = await meetingSource(ref.source);
    const meeting = await source.load(ref.id);
    const block = source.describe(meeting);
    const existing = options.meetingRef
        ? options.store.resolve(options.meetingRef)
        : options.store.resolve(`${ref.source}:${meeting.sourceMeetingId}`);

    if (options.meetingRef && !existing) {
        throw new Error(`No meeting "${options.meetingRef}" (${toolCommand("meetings", "list")})`);
    }

    const { project } = await resolveProject({
        config: options.config,
        flag: options.project,
        current: existing?.project,
        facts: { wisprflowFolders: meeting.folders, calendar: meeting.calendar?.calendar, title: meeting.title },
        quiet: options.quiet,
    });
    const change = `${source.label} ${meeting.sourceMeetingId}: ${meeting.transcript.length} lines, ${meeting.participants.length} people`;
    log.debug({ source: ref.source, id: meeting.sourceMeetingId, existing: existing?.id, project }, "link source");

    if (existing) {
        const record = await options.store.update(existing.id, { command: options.command, change }, (current) => {
            applySource({ record: current, sourceId: ref.source, block, meeting, refresh: options.refresh });
            current.project ??= project;
        });
        return { record, created: false };
    }

    const record = await options.store.create(
        {
            title: meeting.title,
            start: meeting.start,
            createdBy: options.createdBy,
            ...(project ? { project } : {}),
            ...(meeting.end ? { end: meeting.end } : {}),
            sources: { [ref.source]: block },
            participants: meeting.participants,
            ...(meeting.calendar ? { calendar: meeting.calendar } : {}),
        },
        { command: options.command, change: `created from ${change}` }
    );
    return { record, created: true };
}

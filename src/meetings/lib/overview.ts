import type { MeetingsConfig } from "@genesiscz/utils/meetings/config";
import type { MeetingRecord } from "@genesiscz/utils/meetings/record";
import { openQuestions } from "./questions";

/** What one meeting still needs, as counts and flags a list row can show without reading the record again. */
export interface MeetingBadges {
    noProject: boolean;
    /** Questions waiting for an answer by ear. */
    openQuestions: number;
    /** Suggested speaker ranges and labels that track no one person: whose voice a stretch is stays open. */
    unclearSpeakers: number;
    /** A screen recording and no transcript source. */
    recordingOnly: boolean;
    /** A transcript source and no screen recording. */
    transcriptOnly: boolean;
    /** Suggested items (questions left out) at or above `global.suggest.applyAbove`: ready to confirm in one look. */
    suggestedAboveApply: number;
    /** Every suggested item that is not a question. */
    suggested: number;
}

export interface OverviewMeeting {
    id: string;
    title: string;
    start: string;
    end?: string;
    durationSec?: number;
    /** The local calendar day of the start, `YYYY-MM-DD`. */
    day: string;
    project?: string;
    labels: string[];
    hasTranscript: boolean;
    hasRecording: boolean;
    /** The screen is being recorded now. */
    live: boolean;
    frames: number;
    contextCount: number;
    badges: MeetingBadges;
}

export interface MeetingsOverview {
    generatedAt: string;
    days: number;
    applyAbove: number;
    meetings: OverviewMeeting[];
    /** Every known project with the number of its meetings in the window, in config order. */
    projects: Array<{ name: string; meetings: number }>;
    /** The meetings of the window that wait for a person, one list per reason, newest first. */
    needsYou: {
        noProject: string[];
        questions: Array<{ id: string; count: number }>;
        suggestions: Array<{ id: string; count: number }>;
        total: number;
    };
}

/** `YYYY-MM-DD` of an instant in a time zone (the system's when none is given). */
export function localDay(iso: string, timeZone?: string): string {
    return new Intl.DateTimeFormat("sv-SE", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).format(new Date(iso));
}

export function meetingBadges(record: MeetingRecord, applyAbove: number): MeetingBadges {
    const suggested = record.items.filter((item) => item.status === "suggested" && item.kind !== "question");
    const hasTranscript = Object.keys(record.sources).length > 0;
    const hasRecording = (record.recording?.frames ?? 0) > 0;

    return {
        noProject: !record.project,
        openQuestions: openQuestions(record).length,
        unclearSpeakers: suggested.filter((item) => item.kind === "speaker-range" || item.kind === "label").length,
        recordingOnly: hasRecording && !hasTranscript,
        transcriptOnly: hasTranscript && !hasRecording,
        suggestedAboveApply: suggested.filter((item) => (item.confidence ?? 0) >= applyAbove).length,
        suggested: suggested.length,
    };
}

/**
 * The meetings that started in the last `days` days (newest first), each with its badges, plus what waits for a
 * person. Reads only: the records and the config are passed in.
 */
export function meetingsOverview(options: {
    records: MeetingRecord[];
    config: MeetingsConfig;
    now: Date;
    days: number;
    timeZone?: string;
}): MeetingsOverview {
    const { config, now, days, timeZone } = options;
    const applyAbove = config.global.suggest.applyAbove;
    const since = now.getTime() - days * 24 * 60 * 60_000;
    const meetings = options.records
        .filter((record) => Date.parse(record.start) >= since)
        .sort((a, b) => Date.parse(b.start) - Date.parse(a.start))
        .map((record): OverviewMeeting => {
            const durationSec = record.end
                ? Math.max(0, Math.round((Date.parse(record.end) - Date.parse(record.start)) / 1000))
                : undefined;

            return {
                id: record.id,
                title: record.title,
                start: record.start,
                ...(record.end ? { end: record.end } : {}),
                ...(durationSec !== undefined ? { durationSec } : {}),
                day: localDay(record.start, timeZone),
                ...(record.project ? { project: record.project } : {}),
                labels: record.labels,
                hasTranscript: Object.keys(record.sources).length > 0,
                hasRecording: (record.recording?.frames ?? 0) > 0,
                live: record.recording?.status === "recording" || record.recording?.status === "paused",
                frames: record.recording?.frames ?? 0,
                contextCount: record.context.length,
                badges: meetingBadges(record, applyAbove),
            };
        });
    const noProject = meetings.filter((meeting) => meeting.badges.noProject && !meeting.live).map((m) => m.id);
    const questions = meetings
        .filter((meeting) => meeting.badges.openQuestions > 0)
        .map((meeting) => ({ id: meeting.id, count: meeting.badges.openQuestions }));
    const suggestions = meetings
        .filter((meeting) => meeting.badges.suggestedAboveApply > 0)
        .map((meeting) => ({ id: meeting.id, count: meeting.badges.suggestedAboveApply }));

    return {
        generatedAt: now.toISOString(),
        days,
        applyAbove,
        meetings,
        projects: Object.keys(config.projects).map((name) => ({
            name,
            meetings: meetings.filter((meeting) => meeting.project === name).length,
        })),
        needsYou: {
            noProject,
            questions,
            suggestions,
            total: new Set([...noProject, ...questions.map((q) => q.id), ...suggestions.map((s) => s.id)]).size,
        },
    };
}

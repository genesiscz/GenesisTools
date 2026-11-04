import { renderFrontmatter } from "@genesiscz/utils/json2md/frontmatter";
import type { MeetingCalendar } from "@genesiscz/utils/meetings/record";
import {
    entriesToSrt,
    entriesToVtt,
    formatClock,
    groupTurns,
    localTime,
    transcriptMarkdown,
    transcriptTextLines,
} from "@genesiscz/utils/transcribe/render";
import { firstName } from "@genesiscz/utils/transcribe/speakers";
import type { Meeting, SourceName, TranscriptGap } from "./types";

export interface RenderOptions {
    source: SourceName;
    frontmatter: boolean;
    summary: boolean;
    timestamps: boolean;
    firstNames: boolean;
}

export function transcriptGapNote(gap: TranscriptGap): string {
    return (
        `Wispr Flow's refined transcript ends at ${formatClock(gap.refinedUntilSec)}, the last live line at ` +
        `${formatClock(gap.liveUntilSec)}; ${gap.appendedLines} unrefined live lines follow after ${formatClock(gap.refinedUntilSec)}.`
    );
}

function durationMinutes(meeting: Meeting): number | undefined {
    if (!meeting.end) {
        return undefined;
    }

    return Math.round((new Date(meeting.end).getTime() - new Date(meeting.start).getTime()) / 60_000);
}

export function speakersOf(meeting: Meeting, useFirstNames: boolean): string[] {
    const names = new Set(meeting.transcript.map((e) => (useFirstNames ? firstName(e.speaker) : e.speaker)));
    return [...names];
}

export function meetingFrontmatter(meeting: Meeting, options: RenderOptions): Record<string, unknown> {
    const minutes = durationMinutes(meeting);
    const end = meeting.end ? localTime(meeting.end).slice(11) : undefined;

    return {
        title: meeting.title,
        meeting: end ? `${localTime(meeting.start)}–${end}` : localTime(meeting.start),
        ...(minutes === undefined ? {} : { duration_min: minutes }),
        speakers: speakersOf(meeting, options.firstNames),
        wisprflow_id: meeting.id,
        ...(meeting.shareLink ? { source: meeting.shareLink } : {}),
        ...(meeting.folders.length > 0 ? { folders: meeting.folders.map((f) => f.name) } : {}),
        wisprflow_source: options.source,
    };
}

export function renderMarkdown(meeting: Meeting, options: RenderOptions): string {
    const parts: string[] = [];

    if (options.frontmatter) {
        parts.push(renderFrontmatter(meetingFrontmatter(meeting, options)));
    }

    parts.push(`# ${meeting.title || "Untitled meeting"}`);

    if (options.summary && meeting.summary.trim()) {
        parts.push("## Summary", meeting.summary.trim());
    }

    if (meeting.transcript.length > 0) {
        if (meeting.transcriptGap) {
            parts.push(`> [!warning] Partly unrefined\n> ${transcriptGapNote(meeting.transcriptGap)}`);
        }

        parts.push(
            "## Transcript",
            transcriptMarkdown(groupTurns(meeting.transcript, options.firstNames), options.timestamps)
        );
    }

    return `${parts.join("\n\n")}\n`;
}

export function renderText(meeting: Meeting, options: RenderOptions): string {
    const lines: string[] = [meeting.title, localTime(meeting.start), ""];

    if (options.summary && meeting.summary.trim()) {
        lines.push("SUMMARY", "", meeting.summary.trim(), "", "TRANSCRIPT", "");
    }

    lines.push(...transcriptTextLines(groupTurns(meeting.transcript, options.firstNames), options.timestamps));

    return `${lines.join("\n").trimEnd()}\n`;
}

export function renderSrt(meeting: Meeting, options: RenderOptions): string {
    return entriesToSrt(meeting.transcript, options.firstNames);
}

export function renderVtt(meeting: Meeting, options: RenderOptions): string {
    return entriesToVtt(meeting.transcript, options.firstNames);
}

/** What `tools wisprflow meetings show` prints: the front matter, the title, participants, invitees, summary and notes. */
export function showMarkdown(meeting: Meeting, source: SourceName, invited: MeetingCalendar | undefined): string {
    const parts = [
        renderFrontmatter(
            meetingFrontmatter(meeting, {
                source,
                frontmatter: true,
                summary: true,
                timestamps: false,
                firstNames: false,
            })
        ),
        `# ${meeting.title || "Untitled meeting"}`,
    ];
    // Who named each label matters: a platform name is evidence, a language model's name is a guess.
    const people = meeting.participants.map((p) => {
        const speaker = p.speakerId === undefined ? "" : `speaker ${p.speakerId}`;
        const origin = p.origin ? `named by ${p.origin}` : "";
        const notes = [speaker, origin].filter(Boolean).join(", ");
        return `- ${p.name}${p.isSelf ? " (you)" : ""}${notes ? ` (${notes})` : ""}`;
    });

    if (people.length > 0) {
        parts.push("## Participants", people.join("\n"));
    }

    if (invited && invited.attendees.length > 0) {
        parts.push(
            "## Invited",
            [
                ...invited.attendees.map((name) => `- ${name}`),
                ...(invited.conferenceUrl ? [``, `Call: ${invited.conferenceUrl}`] : []),
            ].join("\n")
        );
    }

    if (meeting.summary.trim()) {
        parts.push("## Summary", meeting.summary.trim());
    }

    if (meeting.notes.trim()) {
        parts.push("## Notes", meeting.notes.trim());
    }

    return `${parts.join("\n\n")}\n`;
}

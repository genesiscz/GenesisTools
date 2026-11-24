import { json2md } from "@genesiscz/utils/json2md";
import type { MeetingRecord } from "@genesiscz/utils/meetings/record";
import { localTime, type Turn, transcriptBlocks } from "@genesiscz/utils/transcribe/render";

export interface TranscriptDocumentInput {
    record: Pick<MeetingRecord, "id" | "title" | "start" | "project" | "sources">;
    turns: Turn[];
    /** The people after the corrections, with their line counts; an open speaker mark is not a speaker. */
    speakers: Array<{ name: string; lines: number }>;
    /** The people a guess mark (`[Name: 60 %]`) names while its question is open, with their line counts. */
    guesses: Array<{ name: string; lines: number }>;
    unattributed: Array<{ name: string; lines: number }>;
    frontmatter: boolean;
    timestamps: boolean;
    playLink?: (startSec: number) => string | null;
}

/** The `tools meetings transcript` Markdown file: front matter, the title and the turns. */
export function transcriptDocument(input: TranscriptDocumentInput): string {
    const { record, turns, speakers, guesses, unattributed } = input;

    return json2md(transcriptBlocks(turns, input.timestamps, { playLink: input.playLink }), {
        title: record.title || "Untitled meeting",
        ...(input.frontmatter
            ? {
                  frontmatter: {
                      title: record.title,
                      meeting: localTime(record.start),
                      ...(record.project ? { project: record.project } : {}),
                      meeting_id: record.id,
                      sources: Object.keys(record.sources),
                      speakers: Object.fromEntries(speakers.map((speaker) => [speaker.name, speaker.lines])),
                      // A guess is not a named person: files written before 2026-11-24 listed guesses under speakers.
                      ...(guesses.length > 0
                          ? { guesses: Object.fromEntries(guesses.map((guess) => [guess.name, guess.lines])) }
                          : {}),
                      ...(unattributed.length > 0
                          ? {
                                unattributed: Object.fromEntries(
                                    unattributed.map((speaker) => [speaker.name, speaker.lines])
                                ),
                            }
                          : {}),
                  },
              }
            : {}),
    });
}

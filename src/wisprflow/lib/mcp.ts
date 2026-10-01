import { data, isError, type Kit, text, withKit } from "@app/scripts/lib/kit";
import { logger } from "@genesiscz/utils/logger";
import type {
    CalendarEvent,
    Folder,
    Meeting,
    MeetingSummary,
    Participant,
    ScratchpadNote,
    TranscriptEntry,
} from "./types";

const { log } = logger.scoped("wisprflow-mcp");

const SERVER = "wisprflow";
/** The server refuses larger pages. */
const PAGE_CHARS = 40_000;
const CONTINUE_RE =
    /\(\.\.\.truncated, \d+ chars remaining; continue with view_(?:transcript|content)\.start_char=(\d+)\.\.\.\)/;
const MARKER_RE = /^<<<.*>>>$/;

/**
 * One page is `<<<header>>>\n` + the raw character range + `\n\n(...truncated...)\n<<<END>>>`.
 * Only the range is the text; the wrapper must go before pages are joined, or a label cut at a
 * page boundary ("S" | "peaker 1:") becomes two lines.
 */
export function pageText(body: string): string {
    return body
        .replace(/^<<<[^\n]*>>>\n/, "")
        .replace(/\n?<<<END[^\n]*>>>\s*$/, "")
        .replace(new RegExp(`\\n\\n${CONTINUE_RE.source}\\s*$`), "");
}

export class McpUnavailableError extends Error {
    constructor(reason: string) {
        super(`Wispr Flow MCP is not reachable: ${reason}`);
    }
}

interface RawMeeting {
    id: string;
    title: string;
    content?: string;
    content_excerpt?: string;
    summary?: string;
    has_transcript?: boolean;
    start: string;
    end?: string;
    modified_at?: string;
    share_link?: string | null;
    folders?: Folder[] | null;
    transcript?: string | null;
}

interface Page<T> {
    has_more?: boolean;
    next_cursor?: string;
    meetings?: T[];
    notes?: T[];
    events?: T[];
}

async function call<T>(kit: Kit, tool: string, args: Record<string, unknown>): Promise<T> {
    log.debug({ tool, args }, "calling wisprflow MCP");
    const raw = await kit.call(SERVER, tool, args);

    if (isError(raw)) {
        throw new Error(`wisprflow ${tool} failed: ${text(raw)}`);
    }

    const parsed = data<T>(raw);

    if (parsed === undefined) {
        throw new Error(`wisprflow ${tool} returned no JSON: ${text(raw).slice(0, 200)}`);
    }

    return parsed;
}

/** Opens one MCP session for `fn`. Every connection failure becomes one plain error. */
export async function withMcp<T>(fn: (kit: Kit) => Promise<T>): Promise<T> {
    try {
        return await withKit(fn, { servers: [SERVER], timeoutMs: 60_000 });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn({ err }, "wisprflow MCP call failed");

        if (/ECONNREFUSED|fetch failed|No enabled MCP server|401|403|Unauthorized|timed out/i.test(message)) {
            throw new McpUnavailableError(message);
        }

        throw err;
    }
}

function toSummary(raw: RawMeeting): MeetingSummary {
    return {
        id: raw.id,
        title: raw.title,
        start: raw.start,
        end: raw.end,
        modifiedAt: raw.modified_at,
        hasTranscript: raw.has_transcript ?? false,
        shareLink: raw.share_link ?? undefined,
        folders: raw.folders ?? [],
        excerpt: raw.content_excerpt,
    };
}

async function paged<T>(kit: Kit, tool: string, args: Record<string, unknown>, key: keyof Page<T>): Promise<T[]> {
    const limit = typeof args.limit === "number" ? args.limit : 25;
    const items: T[] = [];
    let cursor: string | undefined;

    do {
        const page = await call<Page<T>>(kit, tool, { ...args, limit: Math.min(200, limit - items.length), cursor });
        items.push(...((page[key] as T[] | undefined) ?? []));
        cursor = page.has_more ? page.next_cursor : undefined;
    } while (cursor && items.length < limit);

    return items;
}

export async function listMcpMeetings(filter: {
    query?: string;
    since?: string;
    until?: string;
    limit?: number;
    attendees?: string[];
}): Promise<MeetingSummary[]> {
    return withMcp(async (kit) => {
        const rows = await paged<RawMeeting>(
            kit,
            "search_meetings",
            {
                query: filter.query,
                since: filter.since,
                until: filter.until,
                limit: filter.limit ?? 25,
                attendee_emails: filter.attendees,
                field: filter.query ? "both" : undefined,
            },
            "meetings"
        );
        return rows.map(toSummary);
    });
}

export async function listMcpSeries(meetingId: string, limit = 25): Promise<MeetingSummary[]> {
    return withMcp(async (kit) => {
        const rows = await paged<RawMeeting>(kit, "list_meeting_series", { meeting_id: meetingId, limit }, "meetings");
        return rows.map(toSummary);
    });
}

/** Reads a paginated text field to its end, following the server's continuation marker. */
async function readAll(kit: Kit, meetingId: string, field: "transcript" | "content"): Promise<string> {
    const view = field === "transcript" ? "view_transcript" : "view_content";
    const chunks: string[] = [];
    let start: number | undefined = 0;

    while (start !== undefined) {
        const page: RawMeeting = await call<RawMeeting>(kit, "get_meeting", {
            meeting_id: meetingId,
            [view]: { start_char: start, char_limit: PAGE_CHARS },
        });
        const body = page[field] ?? "";
        const next = body.match(CONTINUE_RE);
        chunks.push(pageText(body));
        const following = next ? Number(next[1]) : undefined;
        // A marker that does not move forward would ask for the same page forever.
        start = following !== undefined && following > start ? following : undefined;
    }

    return chunks.join("");
}

/** The MCP transcript is `Name: text` per line, wrapped in marker lines. */
export function parseMcpTranscript(raw: string): TranscriptEntry[] {
    const entries: TranscriptEntry[] = [];

    for (const line of raw.split("\n")) {
        const trimmed = line.trim();

        if (!trimmed || MARKER_RE.test(trimmed)) {
            continue;
        }

        const colon = trimmed.indexOf(": ");

        if (colon <= 0) {
            const last = entries.at(-1);

            if (last) {
                last.text = `${last.text} ${trimmed}`;
            }

            continue;
        }

        const speaker = trimmed.slice(0, colon);
        const numbered = speaker.match(/^Speaker (\d+)$/);
        entries.push({
            speaker,
            speakerId: numbered ? Number(numbered[1]) : undefined,
            text: trimmed.slice(colon + 2).trim(),
        });
    }

    return entries;
}

export async function getMcpMeeting(id: string, options: { transcript: boolean }): Promise<Meeting> {
    return withMcp(async (kit) => {
        const head = await call<RawMeeting>(kit, "get_meeting", { meeting_id: id });
        const [content, transcript, people] = await Promise.all([
            readAll(kit, id, "content"),
            options.transcript && head.has_transcript ? readAll(kit, id, "transcript") : Promise.resolve(""),
            call<{ participants?: Array<{ name: string; origin?: string; is_self?: boolean }> }>(
                kit,
                "get_meeting_participants_enriched",
                { meeting_id: id }
            ),
        ]);
        const participants: Participant[] = (people.participants ?? []).map((p) => ({
            name: p.name,
            origin: p.origin,
            isSelf: p.is_self,
        }));
        log.debug({ id, transcriptChars: transcript.length, participants: participants.length }, "read MCP meeting");

        return {
            ...toSummary(head),
            summary: head.summary ?? "",
            notes: content,
            participants,
            transcript: parseMcpTranscript(transcript),
        };
    });
}

export async function listMcpNotes(query?: string, limit = 25): Promise<ScratchpadNote[]> {
    return withMcp(async (kit) => {
        const rows = await paged<{ id: string; title: string; modified_at: string; content_excerpt?: string }>(
            kit,
            "search_scratchpad_notes",
            { query, limit },
            "notes"
        );
        return rows.map((row) => ({
            id: row.id,
            title: row.title,
            modifiedAt: row.modified_at,
            excerpt: row.content_excerpt,
        }));
    });
}

export async function getMcpNote(id: string): Promise<ScratchpadNote> {
    return withMcp(async (kit) => {
        const row = await call<{ id: string; title: string; modified_at: string; content?: string }>(
            kit,
            "get_scratchpad_note",
            { note_id: id, view_content: { char_limit: PAGE_CHARS } }
        );
        return { id: row.id, title: row.title, modifiedAt: row.modified_at, content: row.content };
    });
}

interface RawEvent {
    calendar_id: string;
    title: string;
    start: string;
    end: string;
    conference_url?: string;
    attendees?: Array<{ name?: string; email?: string }>;
}

function toEvent(raw: RawEvent): CalendarEvent {
    return {
        id: raw.calendar_id,
        title: raw.title,
        start: raw.start,
        end: raw.end,
        conferenceUrl: raw.conference_url,
        attendees: (raw.attendees ?? []).map((a) => a.name ?? a.email ?? "?"),
    };
}

export async function listMcpUpcoming(hours: number): Promise<CalendarEvent[]> {
    return withMcp(async (kit) => {
        const rows = await paged<RawEvent>(kit, "list_upcoming_meetings", { window_hours: hours, limit: 50 }, "events");
        return rows.map(toEvent);
    });
}

export async function searchMcpCalendar(filter: {
    query?: string;
    since?: string;
    until?: string;
}): Promise<CalendarEvent[]> {
    return withMcp(async (kit) => {
        const rows = await paged<RawEvent>(kit, "search_calendar_events", { ...filter, limit: 50 }, "events");
        return rows.map(toEvent);
    });
}

export async function resolveMcpShareLink(url: string): Promise<{ meetingId?: string; title?: string }> {
    return withMcp(async (kit) => {
        const raw = await call<{ meeting_id?: string; id?: string; title?: string }>(kit, "resolve_share_link", {
            url,
        });
        return { meetingId: raw.meeting_id ?? raw.id, title: raw.title };
    });
}

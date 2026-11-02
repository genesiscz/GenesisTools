import { buildMeetingAttendance } from "@app/ms-teams/lib/attendance";
import { openCache } from "@app/ms-teams/lib/cache";
import { readCallLogEvents } from "@app/ms-teams/lib/call-log";
import { printConversations } from "@app/ms-teams/lib/display";
import { liveWebLogRoot } from "@app/ms-teams/lib/paths";
import { mergeShowQuery, parseShowQuery } from "@app/ms-teams/lib/query";
import { resolveConversation } from "@app/ms-teams/lib/resolve-chat";
import type { AttendanceRow, MeetingAttendance } from "@app/ms-teams/lib/types";
import { suggestCommand } from "@genesiscz/utils/cli";
import { formatLocalDateTimeStamp } from "@genesiscz/utils/date";
import { out } from "@genesiscz/utils/logger";
import { createBoxTable, renderCliHeader, truncateDisplay } from "@genesiscz/utils/table";
import type { Command } from "commander";

export function registerMeetingsCommand(program: Command): void {
    const meetings = program
        .command("meetings")
        .description("List cached meeting chats, or show who joined and left a meeting call")
        .option("--with <name>", "Filter by participant")
        .option("--json", "Machine-readable JSON")
        .action((opts: { with?: string; json?: boolean }) => listMeetings(opts));

    meetings
        .command("list")
        .description("List cached meeting chats")
        .option("--with <name>", "Filter by participant")
        .option("--json", "Machine-readable JSON")
        .action((_opts: unknown, command: Command) => listMeetings(command.optsWithGlobals()));

    meetings
        .command("attendance [query...]")
        .description("Who was in each call of a meeting chat, with join and leave times")
        .option("--id <threadId>", "Exact conversation id")
        .option("--call <callId>", "Only this call of the meeting chat")
        .option("--json", "Machine-readable JSON")
        .action((queryParts: string[], _opts: unknown, command: Command) => {
            const opts: { id?: string; call?: string; json?: boolean } = command.optsWithGlobals();
            const cache = openCache();

            try {
                const resolved = resolveConversation(
                    cache,
                    mergeShowQuery(parseShowQuery((queryParts ?? []).join(" ")), { id: opts.id })
                );

                if (resolved.status !== "exact") {
                    out.println("Could not resolve a single meeting chat. Pass --id.");
                    out.println(suggestCommand("tools ms-teams meetings", { replaceCommand: ["meetings", "list"] }));
                    process.exitCode = 1;
                    return;
                }

                const records = buildMeetingAttendance({
                    cache,
                    conversation: resolved.conversation,
                    liveEvents: readCallLogEvents(liveWebLogRoot()),
                    callId: opts.call,
                });

                if (opts.json) {
                    out.result(records);
                    return;
                }

                if (records.length === 0) {
                    out.println("No calls found for that meeting chat in the Teams cache or the web-client log.");
                    return;
                }

                for (const record of records) {
                    printAttendance(record);
                }
            } finally {
                cache.close();
            }
        });
}

function listMeetings(opts: { with?: string; json?: boolean }): void {
    const cache = openCache();

    try {
        const rows = cache.listConversations({ type: "meeting", withName: opts.with, limit: 100 });

        if (opts.json) {
            out.result(rows);
            return;
        }

        printConversations(rows);
    } finally {
        cache.close();
    }
}

function printAttendance(record: MeetingAttendance): void {
    const { meeting } = record;
    const span = `${clock(meeting.startedAt)} to ${clock(meeting.endedAt)}`;
    renderCliHeader(meeting.title, span);
    out.println(`call ${meeting.callId} · organizer ${meeting.organizer ?? "—"}`);
    const table = createBoxTable(["NAME", "EMAIL", "JOINED", "LEFT", "SOURCE"]);

    for (const row of record.attendance) {
        table.push([
            truncateDisplay(row.self ? `${row.name} (you)` : row.name, 34),
            truncateDisplay(row.email ?? "—", 30),
            joinedCell(row),
            leftCell(row),
            row.source.replace("ms-teams:", ""),
        ]);
    }

    out.println(table.toString());
    out.println("<HH:MM:SS = already in when you joined; >HH:MM:SS = still in when you left.");
}

function joinedCell(row: AttendanceRow): string {
    return row.joinedAt === null ? "—" : `${row.joinedAtExact ? "" : "<"}${clock(row.joinedAt).slice(11)}`;
}

function leftCell(row: AttendanceRow): string {
    return row.leftAt === null ? "—" : `${row.leftAtExact ? "" : ">"}${clock(row.leftAt).slice(11)}`;
}

function clock(iso: string | null): string {
    return iso === null ? "—" : formatLocalDateTimeStamp(iso);
}

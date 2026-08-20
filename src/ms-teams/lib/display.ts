import { formatDateTime } from "@genesiscz/utils/date";
import { out } from "@genesiscz/utils/logger";
import { createBoxTable, renderCliHeader, truncateDisplay } from "@genesiscz/utils/table";
import pc from "picocolors";
import type { ConversationRow, MessageRow, PeopleRow } from "./types";

export function printConversations(rows: ConversationRow[]): void {
    renderCliHeader("Teams conversations", "local client cache");
    const table = createBoxTable(["TITLE", "TYPE", "MEMBERS", "LAST", "ID"]);

    for (const row of rows) {
        const last = row.lastMessageTime ? formatDateTime(row.lastMessageTime, { absolute: "datetime" }) : "—";
        table.push([
            pc.white(truncateDisplay(row.topic || row.title, 40)),
            row.type,
            String(row.memberCount),
            last,
            truncateDisplay(row.id, 36),
        ]);
    }

    out.println(table.toString());
}

export function printPeople(rows: PeopleRow[]): void {
    renderCliHeader("Teams people", "from the local profile cache");
    const table = createBoxTable(["NAME", "EMAIL", "MRI"]);

    for (const row of rows) {
        table.push([
            pc.white(truncateDisplay(row.displayName, 32)),
            truncateDisplay(row.email ?? "—", 32),
            truncateDisplay(row.mri, 40),
        ]);
    }

    out.println(table.toString());
}

export function printSearchHits(rows: MessageRow[], titleFor: (id: string) => string): void {
    renderCliHeader("Teams search", `${rows.length} hits`);
    const table = createBoxTable(["WHEN", "FROM", "CHAT", "TEXT"]);

    for (const row of rows) {
        table.push([
            formatDateTime(row.originalArrivalTime, { absolute: "datetime" }),
            truncateDisplay(row.fromName ?? "—", 22),
            truncateDisplay(titleFor(row.conversationId), 24),
            truncateDisplay(row.text.replace(/\s+/g, " "), 48),
        ]);
    }

    out.println(table.toString());
}

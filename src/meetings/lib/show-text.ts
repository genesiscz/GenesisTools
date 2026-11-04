import { SafeJSON } from "@genesiscz/utils/json";
import type { MeetingRecord } from "@genesiscz/utils/meetings/record";
import { truncateDisplay } from "@genesiscz/utils/table";
import { localTime } from "@genesiscz/utils/transcribe/render";
import { recordingSummary } from "./screen";
import { TOOL } from "./shared";

/** What `tools meetings show` prints: the record's facts, context, renames, item counts and recent history. */
export function showText(record: MeetingRecord): string {
    const lines = [`# ${record.title || "Untitled meeting"}`, ""];
    const when = record.end ? `${localTime(record.start)}–${localTime(record.end).slice(11)}` : localTime(record.start);
    lines.push(`- id: ${record.id}`, `- when: ${when}`);
    lines.push(
        record.project
            ? `- project: ${record.project}`
            : `- project: none (set it: ${TOOL} set ${record.id} --project <name>)`
    );

    for (const [source, block] of Object.entries(record.sources)) {
        lines.push(`- ${source}: ${truncateDisplay(SafeJSON.stringify(block), 140)}`);
    }

    if (record.calendar) {
        const event = record.calendar;
        lines.push(
            `- calendar (${event.from}): ${event.title ?? "?"}${event.attendees.length ? `, ${event.attendees.length} invited` : ""}`
        );
    }

    if (record.participants.length > 0) {
        lines.push(
            `- people: ${record.participants.map((person) => person.name + (person.self ? " (you)" : "")).join(", ")}`
        );
    }

    lines.push(...recordingSummary(record));

    if (record.context.length > 0) {
        lines.push("", "## Context");

        for (const entry of record.context) {
            const label = entry.kind === "note" ? truncateDisplay(entry.ref, 80) : entry.ref;
            lines.push(
                `- ${entry.id} ${entry.kind}: ${entry.title ? `${entry.title}: ` : ""}${label}${entry.note ? ` (${entry.note})` : ""}`
            );
        }
    }

    const renames = Object.entries(record.speakers.labels);

    if (renames.length > 0) {
        lines.push("", "## Speaker renames", ...renames.map(([label, name]) => `- ${label} → ${name}`));
    }

    if (record.items.length > 0) {
        const count = (status: string) => record.items.filter((item) => item.status === status).length;
        lines.push(
            "",
            `## Items: ${count("suggested")} suggested, ${count("confirmed")} confirmed, ${count("rejected")} rejected`
        );
    }

    lines.push(
        "",
        "## History",
        ...record.history.slice(-8).map((entry) => `- ${localTime(entry.at)} ${entry.command}: ${entry.change}`)
    );
    return `${lines.join("\n")}\n`;
}

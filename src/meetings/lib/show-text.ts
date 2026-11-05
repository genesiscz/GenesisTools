import { SafeJSON } from "@genesiscz/utils/json";
import { type Block, json2md } from "@genesiscz/utils/json2md";
import type { MeetingRecord } from "@genesiscz/utils/meetings/record";
import { truncateDisplay } from "@genesiscz/utils/table";
import { localTime } from "@genesiscz/utils/transcribe/render";
import { recordingSummary } from "./screen";
import { TOOL } from "./shared";

/** What `tools meetings show` prints: the record's facts, context, renames, item counts and recent history. */
export function showText(record: MeetingRecord): string {
    const when = record.end ? `${localTime(record.start)}–${localTime(record.end).slice(11)}` : localTime(record.start);
    const facts = [
        `id: ${record.id}`,
        `when: ${when}`,
        record.project
            ? `project: ${record.project}`
            : `project: none (set it: ${TOOL} set ${record.id} --project <name>)`,
        ...(record.labels.length > 0 ? [`labels: ${record.labels.join(", ")}`] : []),
        ...Object.entries(record.sources).map(
            ([source, block]) => `${source}: ${truncateDisplay(SafeJSON.stringify(block), 140)}`
        ),
    ];

    if (record.calendar) {
        const event = record.calendar;
        facts.push(
            `calendar (${event.from}): ${event.title ?? "?"}${event.attendees.length ? `, ${event.attendees.length} invited` : ""}`
        );
    }

    if (record.participants.length > 0) {
        facts.push(
            `people: ${record.participants.map((person) => person.name + (person.self ? " (you)" : "")).join(", ")}`
        );
    }

    facts.push(...recordingSummary(record));

    const blocks: Block[] = [{ ul: facts }];

    if (record.context.length > 0) {
        blocks.push(
            { h2: "Context" },
            {
                ul: record.context.map((entry) => {
                    const label = entry.kind === "note" ? truncateDisplay(entry.ref, 80) : entry.ref;

                    return `${entry.id} ${entry.kind}: ${entry.title ? `${entry.title}: ` : ""}${label}${entry.note ? ` (${entry.note})` : ""}`;
                }),
            }
        );
    }

    const renames = Object.entries(record.speakers.labels);

    if (renames.length > 0) {
        blocks.push({ h2: "Speaker renames" }, { ul: renames.map(([label, name]) => `${label} → ${name}`) });
    }

    if (record.items.length > 0) {
        const count = (status: string) => record.items.filter((item) => item.status === status).length;
        blocks.push({
            h2: `Items: ${count("suggested")} suggested, ${count("confirmed")} confirmed, ${count("rejected")} rejected`,
        });
    }

    blocks.push({ h2: "History" });

    if (record.history.length > 0) {
        blocks.push({
            ul: record.history.slice(-8).map((entry) => `${localTime(entry.at)} ${entry.command}: ${entry.change}`),
        });
    }

    return json2md(blocks, { title: record.title || "Untitled meeting" });
}

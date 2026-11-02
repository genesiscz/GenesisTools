import { ui } from "@genesiscz/utils/cli/ui";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { MeetingStore } from "@genesiscz/utils/meetings/record";
import { createBoxTable } from "@genesiscz/utils/table";
import { formatClock } from "@genesiscz/utils/transcribe/render";
import { presenceSections } from "@genesiscz/utils/transcribe/speakers";
import type { Command } from "commander";
import { loadPresence } from "../lib/attendance";
import { errorText, fail, TOOL } from "../lib/shared";
import { meetingSource } from "../lib/sources";

async function attendance(ref: string, opts: { from?: string; json?: boolean }): Promise<void> {
    const store = new MeetingStore();

    try {
        const record = store.resolve(ref);

        if (!record) {
            fail(`No meeting "${ref}". List them: ${TOOL} list`);
            return;
        }

        let current = record;

        if (opts.from) {
            const linked = Object.entries(record.sources).find(([, block]) => typeof block.meetingId === "string");
            const start =
                linked && typeof linked[1].meetingId === "string"
                    ? (
                          await await meetingSource(linked[0]).then((source) =>
                              source.load(linked[1].meetingId as string)
                          )
                      ).start
                    : record.start;
            const loaded = await loadPresence({ title: record.calendar?.title ?? record.title, start }, opts.from);
            const selfName = record.participants.find((person) => person.self)?.name;
            const people = loaded.presence.map((stay) => ({
                ...stay,
                name: stay.self && selfName ? selfName : stay.name,
            }));
            const lastKnown = Math.max(
                ...people.flatMap((stay) => [stay.fromSec, Number.isFinite(stay.toSec) ? stay.toSec : stay.fromSec])
            );
            const stored = people.map((stay) => ({
                ...stay,
                toSec: Number.isFinite(stay.toSec) ? stay.toSec : lastKnown,
            }));
            const sections = presenceSections(stored);
            current = await store.update(
                record.id,
                {
                    command: "attendance",
                    change: `${stored.length} stays, ${sections.length} sections (${loaded.note})`,
                },
                (next) => {
                    next.attendance = { from: opts.from === "teams" ? "ms-teams" : opts.from!, people: stored };
                    next.sections = sections;
                }
            );
            ui.ok(`${record.id}: ${stored.length} stays, ${sections.length} sections stored.`);
        }

        if (!current.attendance || !current.sections) {
            fail(`${current.id} has no attendance yet. Add it: ${TOOL} attendance ${current.id} --from teams`);
            return;
        }

        if (opts.json) {
            out.result(SafeJSON.stringify({ attendance: current.attendance, sections: current.sections }, null, 2));
            return;
        }

        const table = createBoxTable(["FROM", "TO", "PRESENT"]);

        for (const section of current.sections) {
            table.push([
                formatClock(Math.max(0, section.fromSec)),
                formatClock(section.toSec),
                section.present.join(", "),
            ]);
        }

        out.println(table.toString());
    } catch (err) {
        fail(errorText(err));
    }
}

export function registerAttendanceCommand(program: Command): void {
    program
        .command("attendance")
        .argument("<meeting>", "meeting id, a unique prefix, last, or wisprflow:<id>")
        .description(
            "Who was in the call and when; with --from, store it and its sections in the meeting (the rules read them)"
        )
        .option("--from <teams|file>", "teams asks tools ms-teams by the meeting title, or a file of its --json output")
        .option("--json", "print JSON")
        .action(attendance);
}

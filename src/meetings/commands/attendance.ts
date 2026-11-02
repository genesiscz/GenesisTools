import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { ui } from "@genesiscz/utils/cli/ui";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { MEETING_PLATFORM_IDS } from "@genesiscz/utils/meetings/platform";
import { MeetingStore } from "@genesiscz/utils/meetings/record";
import { createBoxTable } from "@genesiscz/utils/table";
import { formatClock } from "@genesiscz/utils/transcribe/render";
import type { Command } from "commander";
import { loadPresence } from "../lib/attendance";
import { storeAttendance } from "../lib/collect";
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
            current = await storeAttendance({ store, record, loaded, from: opts.from });
            ui.ok(
                `${record.id}: ${current.attendance?.people.length ?? 0} stays, ${current.sections?.length ?? 0} sections stored.`
            );
        }

        if (!current.attendance || !current.sections) {
            fail(
                `${current.id} has no attendance yet. Add it: ${TOOL} attendance ${current.id} --from <${MEETING_PLATFORM_IDS.join("|")}>`
            );
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
        .option(
            "--from <platform|file>",
            `${MEETING_PLATFORM_IDS.join(", ")} (teams asks ${toolCommand("ms-teams")} by the title; facetime reads the call history), or a file of ${toolCommand("ms-teams", "meetings", "attendance", "--json")} output`
        )
        .option("--json", "print JSON")
        .action(attendance);
}

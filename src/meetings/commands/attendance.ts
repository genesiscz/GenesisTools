import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { ui } from "@genesiscz/utils/cli/ui";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { MEETING_PLATFORM_IDS } from "@genesiscz/utils/meetings/platform";
import { MeetingStore } from "@genesiscz/utils/meetings/record";
import { createBoxTable } from "@genesiscz/utils/table";
import { formatClock } from "@genesiscz/utils/transcribe/render";
import type { Command } from "commander";
import { CallTimeline } from "../lib/call-timeline";
import { withMeetingsClient } from "../lib/service/client";
import { fail, TOOL } from "../lib/shared";

function seconds(value: string | undefined): number | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (!/^(\d+:){0,2}\d+(\.\d+)?$/.test(value)) {
        throw new Error(`Invalid time ${value}; use seconds or HH:MM:SS.`);
    }
    return value.split(":").reduce((sum, part) => sum * 60 + Number(part), 0);
}

async function attendance(
    ref: string,
    opts: {
        from?: string;
        id?: string;
        add?: string;
        remove?: string;
        to?: string;
        atMic?: boolean;
        via?: string;
        json?: boolean;
    }
): Promise<void> {
    const store = new MeetingStore();

    try {
        const record = store.resolve(ref);

        if (!record) {
            fail(`No meeting "${ref}". List them: ${TOOL} list`);
            return;
        }

        let current = record;

        if (opts.add || opts.remove) {
            if ((opts.add && opts.remove) || opts.id) {
                throw new Error("Choose one of --add or --remove; --id selects platform attendance only.");
            }
            current = await withMeetingsClient((client) =>
                client.call("meeting.people.edit", {
                    meeting: record.id,
                    name: opts.add ?? opts.remove!,
                    action: opts.add ? "add" : "remove",
                    fromSec: seconds(opts.from),
                    toSec: seconds(opts.to),
                    atMic: opts.atMic,
                    via: opts.via,
                })
            );
        } else if (opts.from) {
            const timeline = await CallTimeline.forRecord(record);
            current = await timeline.store(
                store,
                await timeline.stays(opts.from, opts.id ? { id: opts.id } : undefined),
                opts.from
            );
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
        fail(err);
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
            `${MEETING_PLATFORM_IDS.join(", ")} (teams asks ${toolCommand("ms-teams")} by the title; facetime reads the call history), or a platform's export file: teams:<file> for ${toolCommand("ms-teams", "meetings", "attendance", "--json")} output (a bare path is read in the meeting's platform's format, else in the one format it fits)`
        )
        .option("--id <chat-id>", "exact platform attendance chat id, forwarded unchanged")
        .option("--add <name>", "add or update one meeting person and stay; --from is their join time")
        .option("--remove <name>", "remove one meeting person, stays and device membership")
        .option("--to <time>", "manual person's leave time, seconds or HH:MM:SS")
        .option("--at-mic", "person shares the recording user's microphone")
        .option("--via <owner>", "person shares this remote device owner's microphone")
        .option("--json", "print JSON")
        .action(attendance);
}

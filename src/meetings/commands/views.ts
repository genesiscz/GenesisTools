import { ui } from "@genesiscz/utils/cli/ui";
import { formatBytes } from "@genesiscz/utils/format";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { MeetingsConfigStore } from "@genesiscz/utils/meetings/config";
import { MeetingStore } from "@genesiscz/utils/meetings/record";
import { createBoxTable, truncateDisplay } from "@genesiscz/utils/table";
import { localTime } from "@genesiscz/utils/transcribe/render";
import type { Command } from "commander";
import pc from "picocolors";
import { exportMeeting } from "../lib/export";
import { type MeetingBadges, meetingsOverview } from "../lib/overview";
import { errorText, fail, TOOL } from "../lib/shared";

function badgeWords(badges: MeetingBadges): string {
    return [
        badges.noProject ? "no project" : "",
        badges.openQuestions > 0 ? `${badges.openQuestions} questions` : "",
        badges.unclearSpeakers > 0 ? "unclear speakers" : "",
        badges.recordingOnly ? "recording only" : "",
        badges.transcriptOnly ? "transcript only" : "",
        badges.suggestedAboveApply > 0 ? `${badges.suggestedAboveApply} ready` : "",
    ]
        .filter(Boolean)
        .join(", ");
}

async function overview(opts: { days?: string; json?: boolean }): Promise<void> {
    const days = Number(opts.days ?? "14");

    if (!Number.isFinite(days) || days <= 0) {
        fail(`--days ${opts.days} is not a number of days (try 14).`);
        return;
    }

    try {
        const view = meetingsOverview({
            records: new MeetingStore().list(),
            config: await new MeetingsConfigStore().read(),
            now: new Date(),
            days,
        });

        if (opts.json) {
            out.result(SafeJSON.stringify(view, null, 2));
            return;
        }

        const table = createBoxTable(["DAY", "TIME", "MEETING", "PROJECT", "NEEDS"]);

        for (const meeting of view.meetings) {
            table.push([
                meeting.day,
                localTime(meeting.start).slice(11, 16),
                truncateDisplay(meeting.title, 40),
                meeting.project ?? pc.dim("—"),
                badgeWords(meeting.badges) || pc.dim("—"),
            ]);
        }

        out.println(table.toString());
        ui.dim(`${view.meetings.length} meetings in ${days} days; ${view.needsYou.total} need you`);
    } catch (err) {
        fail(errorText(err));
    }
}

async function exportCommand(ref: string, opts: { to?: string; dryRun?: boolean; json?: boolean }): Promise<void> {
    const store = new MeetingStore();

    try {
        const record = store.resolve(ref);

        if (!record) {
            fail(`No meeting "${ref}". List them: ${TOOL} list`);
            return;
        }

        const result = await exportMeeting({
            store,
            record,
            config: await new MeetingsConfigStore().read(),
            ...(opts.to ? { to: opts.to } : {}),
            dryRun: opts.dryRun === true,
        });

        if (opts.json) {
            out.result(SafeJSON.stringify(result, null, 2));
            return;
        }

        if (result.warning) {
            ui.warn(result.warning);
        }

        const verb = result.written ? (result.replaced ? "Replaced" : "Wrote") : "Would write";
        ui.ok(`${verb} ${result.path} (${formatBytes(result.bytes)})`);
    } catch (err) {
        fail(errorText(err));
    }
}

export function registerViewCommands(program: Command): void {
    program
        .command("overview")
        .description("The recent meetings by day with what each still needs, and the meetings that wait for you")
        .option("--days <n>", "how many days back", "14")
        .option("--json", "print JSON")
        .action(overview);
    program
        .command("export")
        .argument("<meeting>", "meeting id, a unique prefix, last, or wisprflow:<id>")
        .description(
            "Write the polished transcript (play links, dictionary, confirmed items) into the project's notes folder"
        )
        .option("--to <folder>", "this folder instead of the project's export folder (projects.<p>.export.folder)")
        .option("--dry-run", "say where it would go, write nothing")
        .option("--json", "print JSON")
        .action(exportCommand);
}

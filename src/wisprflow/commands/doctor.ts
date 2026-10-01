import { ui } from "@genesiscz/utils/cli/ui";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { localAvailable, pendingSpeakerRenames, WISPR_DIR } from "../lib/local";
import { listMcpMeetings } from "../lib/mcp";
import { errorText } from "./shared";

interface Report {
    local: { ok: boolean; dir: string; error?: string; pendingRenames: Array<{ id: string; title: string }> };
    mcp: { ok: boolean; error?: string };
}

/** Read-only: it opens the database read-only and makes one search call. */
async function doctor(opts: { json?: boolean }): Promise<void> {
    const report: Report = {
        local: { ok: false, dir: WISPR_DIR, pendingRenames: [] },
        mcp: { ok: false },
    };

    if (localAvailable()) {
        try {
            report.local.pendingRenames = pendingSpeakerRenames();
            report.local.ok = true;
        } catch (err) {
            report.local.error = errorText(err);
        }
    } else {
        report.local.error = "the Wispr Flow app data is not on this Mac";
    }

    try {
        await listMcpMeetings({ limit: 1 });
        report.mcp.ok = true;
    } catch (err) {
        report.mcp.error = errorText(err);
    }

    if (opts.json) {
        out.result(SafeJSON.stringify(report, null, 2));
    } else {
        ui.header("Wispr Flow sources");
        (report.local.ok ? ui.ok : ui.err)(`local: ${report.local.ok ? report.local.dir : report.local.error}`);
        (report.mcp.ok ? ui.ok : ui.err)(`mcp: ${report.mcp.ok ? "reachable" : report.mcp.error}`);

        if (!report.mcp.ok) {
            ui.info("Check: tools mcp-manager gateway status");
        }

        for (const meeting of report.local.pendingRenames) {
            ui.warn(`speaker rename not on the server yet: ${meeting.title} (${meeting.id})`);
        }
    }

    if (!report.local.ok && !report.mcp.ok) {
        process.exitCode = 1;
    }
}

export function registerDoctorCommand(program: Command): void {
    program
        .command("doctor")
        .description("Check both sources, and list speaker renames the app has not sent yet (read-only)")
        .option("--json", "machine-readable report")
        .action(doctor);
}

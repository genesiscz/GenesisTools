import { getDaemonPid } from "@app/automate/lib/daemon";
import { getDb } from "@app/automate/lib/db";
import { getDaemonStatus } from "@app/automate/lib/launchd";
import * as p from "@clack/prompts";
import type { Bot } from "grammy";

export function registerStatusCommand(bot: Bot): void {
    bot.command("status", async (ctx) => {
        p.log.step("/status → fetching daemon status + schedules");
        const daemonStatus = await getDaemonStatus();
        const fgPid = getDaemonPid();
        const db = getDb();
        const schedules = db.listSchedules();
        const enabled = schedules.filter((s) => s.enabled);

        const lines = [
            "Daemon:",
            daemonStatus.running
                ? `  Running (launchd, PID ${daemonStatus.pid})`
                : fgPid
                  ? `  Running (foreground, PID ${fgPid})`
                  : daemonStatus.installed
                    ? "  Installed but not running"
                    : "  Not installed",
            "",
            `Schedules: ${enabled.length} active / ${schedules.length} total`,
        ];

        if (enabled.length > 0) {
            lines.push("");
            for (const s of enabled) {
                lines.push(`  ${s.name}: ${s.interval} (next: ${s.next_run_at})`);
            }
        }

        await ctx.reply(lines.join("\n"));
        p.log.success(`/status → replied (${lines.length} lines)`);
    });
}

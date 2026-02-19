import { registerCommand } from "../dispatcher";
import { getDaemonPid } from "@app/automate/lib/daemon";
import { getDaemonStatus } from "@app/automate/lib/launchd";
import { getDb } from "@app/automate/lib/db";

registerCommand("status", async () => {
  const daemonStatus = await getDaemonStatus();
  const fgPid = getDaemonPid();
  const db = getDb();
  const schedules = db.listSchedules();
  const enabled = schedules.filter(s => s.enabled);

  const lines = [
    "Daemon:",
    daemonStatus.running ? `  Running (launchd, PID ${daemonStatus.pid})` :
    fgPid ? `  Running (foreground, PID ${fgPid})` :
    daemonStatus.installed ? "  Installed but not running" :
    "  Not installed",
    "",
    `Schedules: ${enabled.length} active / ${schedules.length} total`,
  ];

  if (enabled.length > 0) {
    lines.push("");
    for (const s of enabled) {
      lines.push(`  ${s.name}: ${s.interval} (next: ${s.next_run_at})`);
    }
  }

  return { text: lines.join("\n") };
});

import { Command } from "commander";
import * as p from "@clack/prompts";
import { startDaemon, getDaemonPid } from "@app/automate/lib/daemon";
import { installLaunchd, uninstallLaunchd, getDaemonStatus } from "@app/automate/lib/launchd";

export function registerDaemonCommand(program: Command): void {
  const daemon = program.command("daemon").description("Manage the scheduler daemon");

  daemon.command("start").description("Run scheduler in foreground").action(async () => {
    const existing = getDaemonPid();
    if (existing) { p.log.error(`Daemon already running (PID ${existing})`); return; }
    p.log.info("Starting scheduler daemon in foreground... (Ctrl+C to stop)");
    await startDaemon();
  });

  daemon.command("install").description("Install macOS launchd plist").action(async () => {
    try { await installLaunchd(); p.log.success("Daemon installed via launchd"); }
    catch (err) { p.log.error(`Failed: ${(err as Error).message}`); }
  });

  daemon.command("uninstall").description("Remove launchd plist").action(async () => {
    await uninstallLaunchd(); p.log.success("Daemon uninstalled");
  });

  daemon.command("status").description("Check daemon status").action(async () => {
    const status = await getDaemonStatus();
    const fgPid = getDaemonPid();
    if (status.running) p.log.success(`Daemon running (launchd, PID ${status.pid})`);
    else if (fgPid) p.log.success(`Daemon running (foreground, PID ${fgPid})`);
    else if (status.installed) p.log.warn("Daemon installed but not running");
    else p.log.info("Daemon not installed. Run: tools automate daemon install");
  });
}

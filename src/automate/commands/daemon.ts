import { existsSync } from "node:fs";
import { Command } from "commander";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { startDaemon, getDaemonPid } from "@app/automate/lib/daemon";
import {
  installLaunchd,
  uninstallLaunchd,
  getDaemonStatus,
  DAEMON_STDOUT_LOG,
  DAEMON_STDERR_LOG,
} from "@app/automate/lib/launchd";

function tailDaemonLogs(): void {
  const files: string[] = [];
  if (existsSync(DAEMON_STDOUT_LOG)) files.push(DAEMON_STDOUT_LOG);
  if (existsSync(DAEMON_STDERR_LOG)) files.push(DAEMON_STDERR_LOG);

  if (files.length === 0) {
    p.log.warn("No daemon logs found. Is the daemon installed?");
    return;
  }

  p.log.info(`Tailing: ${pc.dim(files.join(", "))}`);
  p.log.info(pc.dim("Press Ctrl+C to stop"));

  const proc = Bun.spawn(["tail", "-f", ...files], {
    stdio: ["ignore", "inherit", "inherit"],
  });

  const cleanup = () => { proc.kill(); process.exit(0); };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  proc.exited.then(() => process.exit(0));
}

function showRecentLogs(lines = 20): void {
  const files: string[] = [];
  if (existsSync(DAEMON_STDOUT_LOG)) files.push(DAEMON_STDOUT_LOG);
  if (existsSync(DAEMON_STDERR_LOG)) files.push(DAEMON_STDERR_LOG);

  if (files.length === 0) return;

  const proc = Bun.spawnSync(["tail", `-${lines}`, ...files], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = proc.stdout.toString().trim();
  if (output) {
    p.log.step(pc.underline("Recent logs:"));
    console.log(pc.dim(output));
  }
}

export function registerDaemonCommand(program: Command): void {
  const daemon = program.command("daemon").description("Manage the scheduler daemon");

  daemon.command("start").description("Run scheduler in foreground").action(async () => {
    const existing = getDaemonPid();
    if (existing) {
      p.log.info(`Daemon already running (PID ${existing}). Tailing logs...`);
      tailDaemonLogs();
      return;
    }
    p.log.info("Starting scheduler daemon in foreground... (Ctrl+C to stop)");
    await startDaemon();
  });

  daemon.command("status").description("Check daemon status and show recent logs").action(async () => {
    const status = await getDaemonStatus();
    const fgPid = getDaemonPid();
    if (status.running) {
      p.log.success(`Daemon running (launchd, PID ${status.pid})`);
      showRecentLogs();
      p.log.info(`\nRun ${pc.cyan("tools automate daemon tail")} to follow logs`);
    } else if (fgPid) {
      p.log.success(`Daemon running (foreground, PID ${fgPid})`);
      showRecentLogs();
    } else if (status.installed) {
      p.log.warn("Daemon installed but not running");
    } else {
      p.log.info("Daemon not installed. Run: tools automate daemon install");
    }
  });

  daemon.command("tail").description("Tail daemon logs in real-time").action(() => {
    tailDaemonLogs();
  });

  daemon.command("install").description("Install macOS launchd plist").action(async () => {
    try { await installLaunchd(); p.log.success("Daemon installed via launchd"); }
    catch (err) { p.log.error(`Failed: ${(err as Error).message}`); }
  });

  daemon.command("uninstall").description("Remove launchd plist").action(async () => {
    await uninstallLaunchd(); p.log.success("Daemon uninstalled");
  });
}

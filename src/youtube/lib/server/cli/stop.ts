import { clearPid, readPid } from "@app/youtube/lib/server/daemon";
import { isLaunchdInstalled, uninstallLaunchd } from "@app/youtube/lib/server/launchd";
import { clearPortFile } from "@app/youtube/lib/server/port-file";
import * as p from "@clack/prompts";
import type { Command } from "commander";

interface StopOpts {
    uninstall?: boolean;
}

export function registerServerStop(parent: Command): void {
    parent
        .command("stop")
        .description("Stop the running server (and optionally uninstall the launchd agent)")
        .option("--uninstall", "Also uninstall the launchd agent (macOS) — permanent stop")
        .addHelpText("after", "\nExamples:\n  $ tools youtube server stop\n  $ tools youtube server stop --uninstall\n")
        .action(async (opts: StopOpts) => {
            if (opts.uninstall && isLaunchdInstalled()) {
                await uninstallLaunchd();
                p.log.success("Server uninstalled from launchd.");
            }

            const pid = readPid();

            if (!pid) {
                if (!opts.uninstall) {
                    p.log.info("Server is not running.");
                }
                clearPortFile();
                return;
            }

            try {
                process.kill(pid, "SIGTERM");
                p.log.success(`Sent SIGTERM to PID ${pid}.`);
            } catch (error) {
                p.log.warn(`Could not signal PID ${pid}: ${error instanceof Error ? error.message : String(error)}`);
                clearPid();
                clearPortFile();
            }
        });
}

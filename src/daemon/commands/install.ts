import * as p from "@clack/prompts";
import type { Command } from "commander";
import { getDaemonStatus, installLaunchd, uninstallLaunchd } from "../lib/launchd";

export function registerInstallCommand(program: Command): void {
    program
        .command("install")
        .description("Install macOS launchd plist (auto-start on login)")
        .action(async () => {
            try {
                await installLaunchd();
                p.log.success("Daemon installed via launchd (starts on login)");
            } catch (err) {
                p.log.error(`Failed: ${err instanceof Error ? err.message : String(err)}`);
            }
        });

    program
        .command("uninstall")
        .description("Remove macOS launchd plist")
        .action(async () => {
            const status = await getDaemonStatus();

            if (!status.installed) {
                p.log.info("Daemon is not installed.");
                return;
            }

            await uninstallLaunchd();
            p.log.success("Daemon uninstalled from launchd");
        });
}

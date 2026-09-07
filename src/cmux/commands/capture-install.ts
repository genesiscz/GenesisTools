import {
    type CaptureInstallOptions,
    captureInstallationStatus,
    installCapture,
    planCaptureRcChange,
    uninstallCapture,
} from "@app/cmux/lib/capture-installer";
import * as p from "@clack/prompts";
import { isInteractive } from "@genesiscz/utils/cli";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";

interface Flags {
    home?: string;
    rc?: string;
    json?: boolean;
    screens?: boolean;
    yes?: boolean;
    dryRun?: boolean;
}

export function registerCaptureLifecycleCommands(parent: Command): void {
    for (const action of ["install", "uninstall", "status"] as const) {
        parent
            .command(action)
            .description(
                action === "install"
                    ? "Bundle and install durable cmux capture for future zsh shells"
                    : action === "uninstall"
                      ? "Remove the managed rc block; retain journal data and installed artifacts"
                      : "Inspect capture installation without modifying files"
            )
            .option("--home <directory>", "Home directory containing .genesis-tools (default: configured tools home)")
            .option("--rc <path>", "Zsh rc file to manage (default: <home>/.zshrc)")
            .option("--no-screens", "Disable the background screen collector; retain command capture")
            .option("--json", "Emit installation details as JSON")
            .option("--yes", "Approve changes to the shell rc file without prompting")
            .option("--dry-run", "Preview installation/removal without writing files or starting processes")
            .action(async (flags: Flags) => {
                const options: CaptureInstallOptions & { screens?: boolean } = {
                    home: flags.home,
                    rcPath: flags.rc,
                    screens: flags.screens,
                };
                const beforeStatus = captureInstallationStatus(options);
                if (action !== "status") {
                    const plan = planCaptureRcChange({ ...options, action });
                    if (flags.dryRun) {
                        const preview = {
                            action,
                            rcPath: plan.rcPath,
                            willChangeRc: plan.changesRc,
                            installed: beforeStatus.installed,
                            proposedBlock: plan.block,
                        };
                        if (flags.json) {
                            out.result(preview);
                        } else {
                            out.println(
                                `${action}: ${plan.rcPath}${plan.changesRc ? " will change" : " needs no edit"}\n${plan.block || "Remove the managed cmux capture block."}\nNo files were written. Re-run with --yes to approve rc changes.`
                            );
                        }
                        return;
                    }

                    if (plan.changesRc && !flags.yes) {
                        p.note(
                            plan.block || "Remove only the managed cmux capture block.",
                            `Proposed change to ${plan.rcPath}`
                        );
                        if (!isInteractive()) {
                            out.log.error(
                                "Changing the shell rc file requires confirmation. Re-run with --yes, or use --dry-run to preview. No installation changes were made."
                            );
                            process.exitCode = 1;
                            return;
                        }
                        const approved = await p.confirm({ message: `Apply this change to ${plan.rcPath}?` });
                        if (p.isCancel(approved) || !approved) {
                            p.cancel("No installation changes were made.");
                            return;
                        }
                    }
                    options.rcPath = plan.rcPath;
                    options.expectedRc = plan.before;
                }
                const result =
                    action === "install"
                        ? await installCapture(options)
                        : action === "uninstall"
                          ? uninstallCapture(options)
                          : captureInstallationStatus(options);
                if (action === "install" && beforeStatus.installed) {
                    out.log.warn(
                        "changed" in result && result.changed
                            ? "cmux capture is already installed; updated its generated runtime or configuration."
                            : "cmux capture is already installed and current; no changes were needed."
                    );
                }
                if (flags.json) {
                    out.result(result);
                    return;
                }

                out.println(
                    `cmux capture: ${result.installed ? "installed" : "not installed"}\nrc: ${result.rcPath}\nhook: ${result.hookPath}\nruntime: ${result.runtimePath ?? "not generated"}`
                );
                const screens = result.screens;
                out.println(
                    `screens: ${screens.enabled ? (screens.running ? "running" : "enabled, not running") : screens.running ? "stopping" : "disabled"}${screens.pid ? ` (pid ${screens.pid})` : ""}`
                );
                if ("backupPath" in result && result.backupPath) {
                    out.println(`backup: ${result.backupPath}`);
                }

                if (action === "install") {
                    out.println(
                        "New interactive cmux shells will capture commands. Existing running shells are unchanged."
                    );
                }
            });
    }
}

import { join } from "node:path";
import { isInteractive } from "@genesiscz/utils/cli";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import * as p from "@genesiscz/utils/prompts/p";
import { Storage } from "@genesiscz/utils/storage";
import { formatDotStatus, renderCliHeader, renderCliKeyRow } from "@genesiscz/utils/table";
import type { Command } from "commander";

import { backupDirFor, defaultCodexDesktopApp } from "../lib/desktop/app-bundle";
import { applyDesktopPatch, inspectDesktop, revertDesktopPatch } from "../lib/desktop/apply";
import { desktopPatches } from "../lib/desktop/registry";
import type { DesktopStatus } from "../lib/desktop/types";

function backupRoot(): string {
    return join(new Storage("codex").getBaseDir(), "desktop-patch");
}

function requireMac(): void {
    if (process.platform !== "darwin") {
        throw new Error(`${toolCommand("codex desktop patch")} only supports the macOS Codex desktop app.`);
    }
}

function appPathFrom(command: Command, local: string | undefined): string {
    if (local) {
        return local;
    }

    const inherited = command.optsWithGlobals().app;
    if (typeof inherited === "string" && inherited.length > 0) {
        return inherited;
    }

    return defaultCodexDesktopApp();
}

function printStatus(status: DesktopStatus, json: boolean): void {
    if (json) {
        out.result(SafeJSON.stringify(status, null, 2));
        return;
    }

    renderCliHeader("Codex desktop", `${status.app.version} (${status.app.bundleVersion})`);
    renderCliKeyRow("App", status.app.appPath, 12);
    renderCliKeyRow("Bundle", status.app.bundleId, 12);
    renderCliKeyRow("Running", status.running ? "yes" : "no", 12);
    const active = new Set(status.manifest?.patches.map((patch) => patch.id) ?? []);
    for (const patch of desktopPatches) {
        const on = active.has(patch.id);
        renderCliKeyRow(patch.id, formatDotStatus(on ? "ok" : "dim", on ? "active" : "inactive"), 16);
    }

    renderCliKeyRow("Backup", status.backupDir ?? "none", 12);
}

function confirmationLines(status: DesktopStatus, command: string): string {
    const megabytes = Math.ceil(status.asarBytes / (1024 * 1024));
    return [
        `Refusing to modify ${status.app.appPath} without --yes.`,
        "Patching re-signs the app. macOS then treats it as a different program, so privacy grants for ChatGPT need to be given again. Revert puts the original app and signature back.",
        `The original bundle is copied first (about ${megabytes} MB) to ${backupDirFor(backupRoot(), status.app)}.`,
        "Quit Codex desktop before applying.",
        command,
    ].join("\n");
}

export function registerDesktopCommand(program: Command): void {
    const desktop = program.command("desktop").description("macOS Codex desktop app (ChatGPT.app, com.openai.codex)");
    const patch = desktop
        .command("patch")
        .description("Patch the desktop app's tool-output size")
        .option("--app <path>", "Path to the Codex desktop bundle")
        .option("--json", "Print JSON")
        .action(function (this: Command, options: { app?: string; json?: boolean }) {
            requireMac();
            printStatus(inspectDesktop(appPathFrom(this, options.app), backupRoot()), Boolean(options.json));
        });

    patch
        .command("status")
        .description("Show whether a desktop patch is applied")
        .option("--app <path>", "Path to the Codex desktop bundle")
        .option("--json", "Print JSON")
        .action(function (this: Command, options: { app?: string; json?: boolean }) {
            requireMac();
            printStatus(inspectDesktop(appPathFrom(this, options.app), backupRoot()), Boolean(options.json));
        });

    patch
        .command("list")
        .description("List desktop patches")
        .option("--json", "Print JSON")
        .action(async (options: { json?: boolean }) => {
            const rows = desktopPatches.map((entry) => ({ id: entry.id, description: entry.description }));
            if (options.json) {
                out.result(SafeJSON.stringify(rows, null, 2));
                return;
            }

            renderCliHeader("Desktop patches", toolCommand("codex desktop patch apply"));
            for (const row of rows) {
                renderCliKeyRow(row.id, row.description, 14);
            }
        });

    patch
        .command("apply [ids...]")
        .description("Turn desktop patches on or off. With no names, pick them in a prompt.")
        .option("--app <path>", "Path to the Codex desktop bundle")
        .option(
            "--sign <identity>",
            "codesign identity. 'auto' picks a Developer ID identity, else ad-hoc; '-' is always ad-hoc",
            "auto"
        )
        .option("--yes", "Re-sign the app and write the chosen patches")
        .option("--json", "Print JSON")
        .action(async function (
            this: Command,
            ids: string[] | undefined,
            options: { app?: string; sign?: string; yes?: boolean; json?: boolean }
        ) {
            requireMac();
            const appPath = appPathFrom(this, options.app);
            const root = backupRoot();
            const status = inspectDesktop(appPath, root);
            const active = new Set(status.manifest?.patches.map((patch) => patch.id) ?? []);
            const named = ids ?? [];
            let enabledIds: string[];
            let yes = Boolean(options.yes);
            if (named.length > 0) {
                enabledIds = [...new Set([...active, ...named])];
            } else if (!isInteractive()) {
                printStatus(status, Boolean(options.json));
                out.log.warn(
                    `Name the patches to turn on, or run this in a terminal to pick from the list.\n${toolCommand("codex desktop patch apply", "tool-outputs", "--yes")}`
                );
                process.exitCode = 1;
                return;
            } else {
                p.intro("Codex desktop patches");
                const picked = await p.multiselect({
                    message: "Checked patches stay on. Tool output height is chosen in the app's Settings.",
                    options: desktopPatches.map((patch) => ({
                        value: patch.id,
                        label: patch.id,
                        hint: `${active.has(patch.id) ? "active" : "inactive"} — ${patch.description}`,
                    })),
                    initialValues: [...active],
                    required: false,
                });
                if (p.isCancel(picked)) {
                    p.cancel("Left the desktop patches unchanged.");
                    return;
                }

                enabledIds = picked.filter((value): value is string => typeof value === "string");
                const confirmed = await p.confirm({
                    message:
                        enabledIds.length === 0
                            ? "Restore the original app and its signature?"
                            : "Re-sign the app and write the checked patches? Privacy grants for ChatGPT need to be given again until you revert.",
                    initialValue: false,
                });
                if (p.isCancel(confirmed) || !confirmed) {
                    p.cancel("Left the desktop patches unchanged.");
                    return;
                }

                yes = true;
            }

            const result = applyDesktopPatch({
                appPath,
                backupRoot: root,
                enabledIds,
                signIdentity: options.sign ?? "auto",
                yes,
            });
            if (result.kind === "needs-confirmation") {
                const command = toolCommand("codex desktop patch apply", ...enabledIds, "--yes");
                if (options.json) {
                    out.result(SafeJSON.stringify({ kind: result.kind, command, status: result.status }, null, 2));
                } else {
                    printStatus(result.status, false);
                    out.log.warn(confirmationLines(result.status, command));
                }

                process.exitCode = 1;
                return;
            }

            if (options.json) {
                out.result(SafeJSON.stringify(result, null, 2));
                return;
            }

            printStatus(result.status, false);
            if (result.kind === "unchanged") {
                const message = "No patch changes.";
                if (named.length === 0) {
                    p.outro(message);
                } else {
                    out.log.info(message);
                }

                return;
            }

            const message =
                result.kind === "reverted"
                    ? "Original bundle restored. Quit and reopen Codex desktop."
                    : "Patches written. Quit and reopen Codex desktop, then set tool output, shell commands, and grouped tool calls in Settings. Privacy grants for ChatGPT need to be given again until you revert.";
            if (named.length === 0) {
                p.outro(message);
            } else {
                out.log.warn(message);
            }
        });

    patch
        .command("revert")
        .description("Restore the original app bundle and signature")
        .option("--app <path>", "Path to the Codex desktop bundle")
        .option("--yes", "Write the original files back")
        .option("--json", "Print JSON")
        .action(async function (this: Command, options: { app?: string; yes?: boolean; json?: boolean }) {
            requireMac();
            const result = revertDesktopPatch({
                appPath: appPathFrom(this, options.app),
                backupRoot: backupRoot(),
                yes: Boolean(options.yes),
            });
            if (result.kind === "needs-confirmation") {
                if (options.json) {
                    out.result(
                        SafeJSON.stringify(
                            {
                                kind: result.kind,
                                command: toolCommand("codex desktop patch revert", "--yes"),
                                status: result.status,
                            },
                            null,
                            2
                        )
                    );
                } else {
                    printStatus(result.status, false);
                    out.log.warn(
                        `Refusing to restore the original bundle without --yes.\n${toolCommand("codex desktop patch revert", "--yes")}`
                    );
                }

                process.exitCode = 1;
                return;
            }

            if (options.json) {
                out.result(SafeJSON.stringify(result, null, 2));
                return;
            }

            printStatus(result.status, false);
            if (result.kind === "reverted") {
                out.log.info("Original bundle restored. Quit and reopen Codex desktop.");
            }
        });
}

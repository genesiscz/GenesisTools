import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isInteractive, suggestEnumFlag } from "@genesiscz/utils/cli";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { ui } from "@genesiscz/utils/cli/ui";
import { out } from "@genesiscz/utils/logger";
import { requestFullDiskAccess } from "@genesiscz/utils/macos/full-disk-access";
import {
    genesisAppBundlePath,
    genesisAppDisabledMarkerPath,
    genesisAppLauncherPath,
} from "@genesiscz/utils/macos/genesis-app";
import { genesisAppBuildHint } from "@genesiscz/utils/macos/xcode";
import * as p from "@genesiscz/utils/prompts/p";
import { truncateDisplay } from "@genesiscz/utils/table";
import { Command } from "commander";
import { buildApp, describeSource } from "../../lib/permissions/app";
import { isPermissionKind, PERMISSION_KINDS, permissionStatusLabel } from "../../lib/permissions/kinds";
import type { LocalNetworkAnswer, OldBuild } from "../../lib/permissions/local-network";
import {
    ALL_PART_IDS,
    APP_PARTS,
    normalizeParts,
    PARTS_FLAG_VALUES,
    parsePartsFlag,
} from "../../lib/permissions/parts";
import { type PermissionsReport, permissionsReport, SETTINGS_PANES, settingsUrl } from "../../lib/permissions/report";
import { createBuildProgressDisplay } from "../../lib/permissions/swift-progress";

const PANES = Object.keys(SETTINGS_PANES);

const LAN_LABELS: Record<LocalNetworkAnswer, string> = {
    allowed: "allowed",
    denied: "denied",
    asks: "not asked yet",
    unknown: "unknown (the rule store was not read)",
};

const OLD_BUILD_LAN_LABELS: Record<LocalNetworkAnswer, string> = {
    allowed: "answered, allowed",
    denied: "answered, denied",
    asks: "asks on its first LAN access",
    unknown: "unknown",
};

const OLD_BUILD_PROCESSES_SHOWN = 3;

/** "19:27" today, "10-11 21:22" on another day. */
function clock(date: Date): string {
    const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;

    if (date.toDateString() === new Date().toDateString()) {
        return time;
    }

    return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${time}`;
}

function printOldBuilds(builds: OldBuild[]): void {
    if (builds.length === 0) {
        return;
    }

    ui.section("Old builds still running");

    for (const build of builds) {
        const count = build.processes.length;
        const head = `retired ${clock(build.retiredAt)} · ${count} process${count === 1 ? "" : "es"} · Local Network: ${OLD_BUILD_LAN_LABELS[build.localNetwork]}`;

        if (build.localNetwork === "asks") {
            ui.warn(head);
        } else {
            ui.info(head);
        }

        for (const appProcess of build.processes.slice(0, OLD_BUILD_PROCESSES_SHOWN)) {
            ui.dim(
                `    pid ${appProcess.pid}  since ${clock(appProcess.started)}  ${truncateDisplay(appProcess.command, 70)}`
            );
        }

        if (count > OLD_BUILD_PROCESSES_SHOWN) {
            ui.dim(`    and ${count - OLD_BUILD_PROCESSES_SHOWN} more`);
        }
    }

    ui.dim(
        "  A process keeps the build it started with. After a rebuild, macOS asks once more for Local Network the first time that build reaches your network. The answer covers that build only."
    );
}

function printReport(report: PermissionsReport): void {
    ui.header("GenesisTools.app (TCC identity)");

    if (report.app.built) {
        ui.ok(report.app.bundlePath);
        const sig = report.app.signature;
        const signedLine = sig?.adhoc
            ? "ad-hoc (grants die on rebuild)"
            : `${sig?.authority}${sig?.teamId ? ` [${sig.teamId}]` : ""}`;

        if (report.app.identityStable) {
            ui.kv("signed", signedLine, 11);
        } else {
            ui.warn(`signed     ${signedLine}`);
        }

        ui.kv(
            "built",
            `${report.app.manifest?.builtAt ?? "unknown"}${report.app.stale ? " (stale: sources changed)" : ""}`,
            11
        );
        ui.kv("source", describeSource(report.app.manifest) ?? "unknown (built before the commit was recorded)", 11);
        ui.kv(
            "parts",
            report.app.parts.length > 0
                ? report.app.parts.join(", ")
                : `host only (${toolCommand("hub")} adds the hub)`,
            11
        );
    } else {
        ui.err(`not built (${report.app.bundlePath})`);
    }

    ui.section("This process");
    const identityLabel =
        report.identity.kind === "genesis-app"
            ? `GenesisTools.app (${report.identity.bundleId})`
            : report.identity.kind === "host-app"
              ? `${report.identity.bundleId} (the launching app, not GenesisTools)`
              : "unknown (no bundle; launchd or a bare shell)";

    if (report.identity.kind === "genesis-app") {
        ui.ok(`responsible: ${identityLabel}`);
    } else {
        ui.warn(`responsible: ${identityLabel}`);
    }

    ui.section("Grants for com.genesiscz.genesistools");

    for (const grant of report.grants) {
        const line = `${grant.service.label}: ${grant.label}`;

        if (grant.granted === true) {
            ui.ok(line);
        } else if (grant.granted === false) {
            ui.dim(`  ${line}`);
        } else {
            ui.warn(line);
        }

        for (const target of grant.targets ?? []) {
            const targetLine = `${target.target}: ${target.label}`;

            if (target.granted) {
                ui.ok(`  ${targetLine}`);
            } else {
                ui.dim(`    ${targetLine}`);
            }
        }
    }

    if (report.app.built) {
        const lanLine = `Local Network: ${LAN_LABELS[report.localNetwork]}`;

        if (report.localNetwork === "allowed") {
            ui.ok(lanLine);
        } else if (report.localNetwork === "unknown") {
            ui.warn(lanLine);
        } else {
            ui.dim(`  ${lanLine}`);
        }
    }

    if (!report.userDb.readable) {
        ui.warn(`user TCC.db not readable: ${report.userDb.error}`);
    }

    if (!report.systemDb.readable) {
        ui.info("system TCC.db (Full Disk Access, Accessibility, Screen Recording) needs Full Disk Access to read");
    }

    printOldBuilds(report.oldBuilds);
    ui.section("Verdict");

    if (report.problems.length === 0) {
        ui.ok(
            "GenesisTools.app owns the permissions for this process. Grant each pane once; every terminal shares it."
        );
    } else {
        for (const problem of report.problems) {
            ui.err(problem);
        }
    }

    ui.raw(
        `  Open a pane: ${toolCommand("macos permissions open", "--pane", "<name>")}   (also reveals the .app for drag-and-drop)`
    );
}

export function registerPermissionsCommand(program: Command): void {
    const permissions = new Command("permissions")
        .description("Who owns the macOS privacy grants for tools: GenesisTools.app status, signature, TCC rows")
        .showHelpAfterError(true);

    permissions
        .command("status", { isDefault: true })
        .description("Show the TCC identity of this process and the grants recorded for GenesisTools.app")
        .option("--json", "Print the report as JSON")
        .action((options: { json?: boolean }) => {
            const report = permissionsReport();

            if (options.json) {
                out.result(report);
            } else {
                printReport(report);
            }

            if (report.problems.length > 0) {
                process.exitCode = 1;
            }
        });

    permissions
        .command("build")
        .description("Build, sign and install ~/Applications/GenesisTools.app (Swift toolchain required)")
        .option("--no-relaunch", "Leave the settings, hub, review, widget and Clicky faces closed after the reap")
        .option(
            "--parts [ids]",
            `Build exactly these optional parts, comma-separated: ${PARTS_FLAG_VALUES.join(", ")} (default: the installed ones)`
        )
        .option(
            "--add-part [ids]",
            `Add optional parts to the installed ones, comma-separated: ${ALL_PART_IDS.join(", ")}`
        )
        .action(async (options: { relaunch: boolean; parts?: string | true; addPart?: string | true }) => {
            const exactly = await partsOption(options.parts, "--parts", PARTS_FLAG_VALUES);
            const add = await partsOption(options.addPart, "--add-part", ALL_PART_IDS);

            if (exactly === null || add === null) {
                process.exitCode = 1;
                return;
            }

            const progress = createBuildProgressDisplay({
                step: (message) => ui.info(message),
                spinner: () => out.spinner(),
            });
            const result = await buildApp({
                onStep: progress.onStep,
                onProgress: progress.onProgress,
                relaunch: options.relaunch,
                parts: { exactly, add },
            }).finally(progress.finish);
            ui.ok(`${result.bundlePath}`);
            ui.kv("signed", result.signature.adhoc ? "ad-hoc" : result.signature.authority, 8);
            ui.kv("parts", result.manifest.parts?.length ? result.manifest.parts.join(", ") : "host only", 8);

            if (result.signature.adhoc) {
                ui.warn(
                    "Ad-hoc signature: macOS ties grants to this exact build and forgets them on the next one. Install a Developer ID or Apple Development certificate, or set GENESIS_TOOLS_CODESIGN_IDENTITY."
                );
            }

            ui.raw(`  Next: ${toolCommand("macos permissions")}   (then grant the panes it lists)`);
        });

    permissions
        .command("request")
        .description("Show the GenesisTools dialog for one grant: what it is for, then macOS's own prompt")
        .argument("[kind]", `one of: ${PERMISSION_KINDS.join(", ")}`)
        .option("--reason <text>", "What you need the grant for now; the dialog shows it")
        .action(async (kindArg: string | undefined, options: { reason?: string }) => {
            let kind = kindArg;

            if (!kind && isInteractive()) {
                const { select } = await import("@clack/prompts");
                const picked = await select({
                    message: "Which grant?",
                    options: PERMISSION_KINDS.map((value) => ({ value, label: value })),
                });
                kind = typeof picked === "string" ? picked : undefined;
            }

            if (!kind || !isPermissionKind(kind)) {
                ui.err(kind ? `unknown grant "${kind}"` : "which grant?");
                ui.raw(`  Grants: ${PERMISSION_KINDS.join(", ")}`);
                ui.raw(`  Example: ${toolCommand("macos permissions request", "local-network")}`);
                process.exitCode = 1;
                return;
            }

            const bundle = genesisAppBundlePath();

            if (!existsSync(bundle)) {
                ui.info(
                    `${bundle} is not built, so tools run under the terminal's own identity: macOS asks the terminal app the first time a tool needs ${kind}.`
                );
                return;
            }

            const readStatus = () =>
                permissionStatusLabel(
                    new TextDecoder().decode(
                        Bun.spawnSync([genesisAppLauncherPath(), "--permission-status", kind], {
                            stdout: "pipe",
                            stderr: "pipe",
                            timeout: 10_000,
                        }).stdout
                    )
                );

            // An existing grant needs no dialog, and `open` would take the focus for nothing.
            if (readStatus() === "granted") {
                ui.ok(`${kind}: already granted`);
                return;
            }

            // Launch Services starts the dialog face, so it is its own responsible process and the prompt names
            // GenesisTools. -W waits until the dialog closes.
            const reason = options.reason ? ["--reason", options.reason] : [];
            ui.info("The GenesisTools dialog is open. It closes when the grant is answered or you close it.");
            const dialog = Bun.spawn(
                ["open", "-n", "-W", "-a", bundle, "--args", "--permission-dialog", kind, ...reason],
                {
                    stdout: "pipe",
                    stderr: "pipe",
                }
            );
            const code = await dialog.exited;

            if (code !== 0) {
                const stderr = await new Response(dialog.stderr).text();
                ui.err(`the dialog did not start (open exit ${code}): ${stderr.trim()}`);
                process.exitCode = 1;
                return;
            }

            const label = readStatus();

            if (label === "granted") {
                ui.ok(`${kind}: granted`);
            } else {
                ui.warn(`${kind}: ${label}`);
                ui.raw(`  Open its pane: ${toolCommand("macos permissions ui")} (the window lists every grant)`);
            }
        });

    permissions
        .command("ui")
        .description("Open the GenesisTools window (permissions with request buttons, launchd services, settings)")
        .action(() => {
            const bundle = genesisAppBundlePath();

            if (!existsSync(bundle)) {
                ui.err(`${bundle} is not built. ${genesisAppBuildHint()}`);
                process.exitCode = 1;
                return;
            }

            const opened = Bun.spawnSync(["open", "-a", bundle]);

            if (opened.exitCode !== 0) {
                ui.err(`could not open ${bundle} (exit ${opened.exitCode})`);
                process.exitCode = 1;
                return;
            }

            ui.ok("GenesisTools window opened");
        });

    permissions
        .command("enable")
        .description("Route tools through GenesisTools.app again (removes the disabled marker)")
        .action(() => {
            const marker = genesisAppDisabledMarkerPath();
            rmSync(marker, { force: true });
            ui.ok(`launcher enabled (${marker} removed)`);
        });

    permissions
        .command("disable")
        .description("Run tools under the terminal's own grants (writes the disabled marker the launcher honours)")
        .action(() => {
            const marker = genesisAppDisabledMarkerPath();
            mkdirSync(dirname(marker), { recursive: true });
            writeFileSync(marker, `disabled from ${toolCommand("macos permissions disable")}\n`);
            ui.warn(
                `launcher disabled (${marker}); grants follow the terminal until \`${toolCommand("macos permissions enable")}\``
            );
        });

    permissions
        .command("open")
        .description("Open a Privacy & Security pane and reveal GenesisTools.app in Finder for drag-and-drop")
        .option("--pane [name]", `one of: ${PANES.join(", ")}`)
        .action(async (options: { pane?: string | true }) => {
            let pane = typeof options.pane === "string" ? options.pane : undefined;

            if (!pane && isInteractive()) {
                const { select } = await import("@clack/prompts");
                const picked = await select({
                    message: "Which pane?",
                    options: PANES.map((p) => ({ value: p, label: p })),
                });
                pane = typeof picked === "string" ? picked : undefined;
            }

            if (!pane || !(pane in SETTINGS_PANES)) {
                out.print(suggestEnumFlag("tools macos permissions open", "--pane", PANES));
                process.exitCode = 1;
                return;
            }

            const bundle = genesisAppBundlePath();

            if (!existsSync(bundle)) {
                ui.err(`${bundle} is not built, so there is nothing to grant yet. ${genesisAppBuildHint()}`);
                process.exitCode = 1;
                return;
            }

            if (pane === "full-disk-access") {
                const result = requestFullDiskAccess({
                    reason: "reach Mail, Messages or Voice Memos without this grant",
                    force: true,
                });
                ui.info(`dialog: ${result}`);
            }

            const url = settingsUrl(SETTINGS_PANES[pane]);
            const opened = Bun.spawnSync(["open", url]);

            if (opened.exitCode !== 0) {
                ui.err(`could not open ${url} (exit ${opened.exitCode})`);
                process.exitCode = 1;
                return;
            }

            ui.ok(`opened ${url}`);
            const revealed = Bun.spawnSync(["open", "-R", bundle]);

            if (revealed.exitCode !== 0) {
                ui.warn(
                    `could not reveal ${bundle} in Finder (exit ${revealed.exitCode}); use "+" and pick it under Applications`
                );
                return;
            }

            ui.info(`revealed ${bundle}: drag it into the list, or use "+" and pick it under Applications`);
        });

    program.addCommand(permissions);
}

/**
 * `--parts` / `--add-part`: undefined when not given, the part ids when given a value, a picker on a TTY for the bare
 * flag, and null (with the possible values printed) for a bare flag without a TTY or an unknown part.
 */
async function partsOption(
    value: string | true | undefined,
    flag: string,
    values: readonly string[]
): Promise<string[] | undefined | null> {
    if (value === undefined) {
        return undefined;
    }

    if (value === true) {
        if (!isInteractive()) {
            out.print(suggestEnumFlag("tools macos permissions build", flag, values));
            return null;
        }

        const picked = await p.multiselect({
            message: flag === "--parts" ? "Which optional parts should the app have?" : "Which parts should it add?",
            options: APP_PARTS.map((part) => ({ value: part.id, label: part.id, hint: part.summary })),
            required: false,
        });

        return p.isCancel(picked) ? null : normalizeParts(picked.map(String));
    }

    try {
        return parsePartsFlag(value);
    } catch (error) {
        ui.err(error instanceof Error ? error.message : String(error));
        out.print(suggestEnumFlag("tools macos permissions build", flag, values));
        return null;
    }
}

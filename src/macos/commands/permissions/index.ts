import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isInteractive, suggestEnumFlag } from "@genesiscz/utils/cli";
import { ui } from "@genesiscz/utils/cli/ui";
import { out } from "@genesiscz/utils/logger";
import { requestFullDiskAccess } from "@genesiscz/utils/macos/full-disk-access";
import { genesisAppBundlePath, genesisAppDisabledMarkerPath } from "@genesiscz/utils/macos/genesis-app";
import { Command } from "commander";
import { buildApp } from "../../lib/permissions/app";
import { type PermissionsReport, permissionsReport, SETTINGS_PANES, settingsUrl } from "../../lib/permissions/report";

const PANES = Object.keys(SETTINGS_PANES);

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
    }

    if (!report.userDb.readable) {
        ui.warn(`user TCC.db not readable: ${report.userDb.error}`);
    }

    if (!report.systemDb.readable) {
        ui.info("system TCC.db (Full Disk Access, Accessibility, Screen Recording) needs Full Disk Access to read");
    }

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

    ui.raw("  Open a pane: tools macos permissions open --pane <name>   (also reveals the .app for drag-and-drop)");
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
        .action(async () => {
            const result = await buildApp({ onStep: (message) => ui.info(message) });
            ui.ok(`${result.bundlePath}`);
            ui.kv("signed", result.signature.adhoc ? "ad-hoc" : result.signature.authority, 8);

            if (result.signature.adhoc) {
                ui.warn(
                    "Ad-hoc signature: macOS ties grants to this exact build and forgets them on the next one. Install a Developer ID or Apple Development certificate, or set GENESIS_TOOLS_CODESIGN_IDENTITY."
                );
            }

            ui.raw("  Next: tools macos permissions   (then grant the panes it lists)");
        });

    permissions
        .command("ui")
        .description("Open the GenesisTools window (permissions with request buttons, launchd services, settings)")
        .action(() => {
            const bundle = genesisAppBundlePath();

            if (!existsSync(bundle)) {
                ui.err(`${bundle} is not built. Run: tools macos permissions build`);
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
            writeFileSync(marker, "disabled from tools macos permissions disable\n");
            ui.warn(
                `launcher disabled (${marker}); grants follow the terminal until \`tools macos permissions enable\``
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
                ui.err(`${bundle} is not built, so there is nothing to grant yet. Run: tools macos permissions build`);
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

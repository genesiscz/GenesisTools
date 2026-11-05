import { withInterrupt } from "@genesiscz/utils/cli/interrupt";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { ui } from "@genesiscz/utils/cli/ui";
import { out } from "@genesiscz/utils/logger";
import {
    ALERT_BACKEND_KINDS,
    type AlertBackendKind,
    AlertWatcher,
    alertBackendFor,
} from "@genesiscz/utils/mobile/alerts";
import { readMetroLogFile } from "@genesiscz/utils/mobile/metro";
import { iosApp } from "@genesiscz/utils/mobile/project";
import { attachSession, ensureAppium, pickSimulator, requireAppInstalled } from "@genesiscz/utils/mobile/session";
import { installedAppInfo, launchApp, terminateApp, wdaPortsFor } from "@genesiscz/utils/mobile/simulator";
import type { Command } from "commander";
import { builtAppPath, defaultDerivedData } from "../lib/build";
import { freshInstall, preseedFirstRun } from "../lib/first-run";
import { LOGBOX_CLEAR_MODES, readLogBoxEntries } from "../lib/logbox";
import { loadProject, withConfig } from "../lib/project";

function parseBackends(value: string | undefined): AlertBackendKind[] | undefined {
    if (!value) {
        return undefined;
    }

    const kind = ALERT_BACKEND_KINDS.find((candidate) => candidate === value);

    if (!kind) {
        throw new Error(`--backend must be ${ALERT_BACKEND_KINDS.join(" or ")}, not "${value}"`);
    }

    return [kind];
}

export function registerAppCommands(program: Command): void {
    withConfig(program.command("alerts"))
        .description(
            "Answer the system alerts on a simulator (Open in, notifications, permissions); app alerts are left alone"
        )
        .option("--udid <udid>", "the simulator; default: the only booted one")
        .option("--watch", "keep answering until Ctrl-C")
        .option("--timeout <s>", "without --watch: how long to look for alerts", "5")
        .option("--backend <kind>", `${ALERT_BACKEND_KINDS.join(" or ")} (default: WDA when it runs, else idb)`)
        .option("--json", "print the answers as JSON")
        .action(
            async (options: {
                config?: string;
                udid?: string;
                watch?: boolean;
                timeout: string;
                backend?: string;
                json?: boolean;
            }) => {
                const project = await loadProject(options);
                const ios = iosApp(project);
                const device = await pickSimulator(options.udid);
                const bundleId = ios.bundleId;
                const backend = await alertBackendFor({
                    udid: device.udid,
                    wdaPort: wdaPortsFor(device.udid).wda,
                    order: parseBackends(options.backend),
                });

                if (!backend) {
                    ui.err("no way to read alerts: WDA is not running (start a session) and idb is not installed");
                    ui.dim(`fix: brew install idb-companion, or ${toolCommand("mobile open", "<route>")} first`);
                    process.exitCode = 1;
                    return;
                }

                const appName = (await installedAppInfo(device.udid, bundleId))?.displayName ?? "";
                const watcher = new AlertWatcher({
                    backend,
                    appName,
                    onAnswer: options.json
                        ? undefined
                        : (answer) =>
                              ui.info(
                                  `${answer.rule ?? "unknown"}: ${answer.tapped ? `tapped ${answer.tapped}` : "left alone"} · ${answer.text.replace(/\n/g, " / ")}`
                              ),
                });

                if (options.watch) {
                    ui.info(`watching ${device.name} through ${backend.kind}; Ctrl-C stops`);
                    await withInterrupt(async (signal) => {
                        watcher.start();
                        await new Promise<void>((resolve) =>
                            signal.addEventListener("abort", () => resolve(), { once: true })
                        );
                        watcher.stop();
                    });
                } else {
                    await watcher.answerNow({ timeoutMs: Number(options.timeout) * 1000 });
                }

                if (options.json) {
                    out.result({ backend: backend.kind, answers: watcher.answers });
                } else if (watcher.answers.length === 0) {
                    ui.dim(`no system alert open (read through ${backend.kind})`);
                }
            }
        );

    withConfig(program.command("logbox"))
        .description("Read React Native's LogBox (Debug builds) and Metro's errors, then minimize or clear the LogBox")
        .option("--udid <udid>", "the simulator; default: the only booted one")
        .option("--clear <mode>", `after reading: ${LOGBOX_CLEAR_MODES.join(" or ")}`, "minimize")
        .option("--metro-port <port>", "also read this Metro's log from the newest bundle on (default: the app's)")
        .option("--appium-port <port>", "the Appium server (default: the simulator's own, started when missing)")
        .option("--json", "print as JSON")
        .action(
            async (options: {
                config?: string;
                udid?: string;
                clear: string;
                metroPort?: string;
                appiumPort?: string;
                json?: boolean;
            }) => {
                const clear = LOGBOX_CLEAR_MODES.find((mode) => mode === options.clear);

                if (!clear) {
                    ui.err(`--clear must be ${LOGBOX_CLEAR_MODES.join(" or ")}, not "${options.clear}"`);
                    process.exitCode = 1;
                    return;
                }

                const project = await loadProject(options);
                const ios = iosApp(project);
                const device = await pickSimulator(options.udid);
                const bundleId = ios.bundleId;
                await requireAppInstalled(device.udid, bundleId);
                const port = await ensureAppium({
                    udid: device.udid,
                    port: options.appiumPort ? Number(options.appiumPort) : undefined,
                });
                const session = await attachSession({ udid: device.udid, bundleId, appiumPort: port, launch: false });
                const logbox = await readLogBoxEntries(session, { clear }).finally(() => session.close());
                const metroPort = options.metroPort ? Number(options.metroPort) : project.config.metro?.defaultPort;
                const metro = metroPort ? { port: metroPort, ...readMetroLogFile(metroPort) } : null;

                if (options.json) {
                    out.result({ logbox, metro });
                } else {
                    logbox.entries.length === 0
                        ? logbox.before === "none"
                            ? ui.ok("no LogBox entry")
                            : ui.err("visible LogBox could not be read")
                        : ui.warn(`${logbox.entries.length} LogBox entr${logbox.entries.length === 1 ? "y" : "ies"}`);

                    for (const entry of logbox.entries) {
                        ui.info(`${entry.index}/${entry.total} ${entry.heading ?? ""}`.trim());

                        for (const line of entry.message.slice(0, 12)) {
                            ui.dim(`  ${line}`);
                        }
                    }

                    for (const line of metro?.fatal ?? []) {
                        ui.err(`metro :${metro?.port}: ${line}`);
                    }

                    for (const line of metro?.console ?? []) {
                        ui.dim(`metro :${metro?.port}: ${line}`);
                    }
                }

                if (logbox.before !== "none" || logbox.entries.length > 0 || (metro?.fatal.length ?? 0) > 0) {
                    process.exitCode = 1;
                }
            }
        );

    withConfig(program.command("first-run"))
        .description(
            "Put the app into its fresh-install state: reinstall, grant permissions, then launch and answer the first prompts"
        )
        .option("--udid <udid>", "the simulator; default: the only booted one")
        .option("--app-path <path>", "the .app to install (default: the Release build in --derived-data)")
        .option("--derived-data <dir>", "the DerivedData folder of the build (default <app>/ios/build)")
        .option("--configuration <name>", "Debug or Release, for the default --app-path", "Release")
        .option("--keep-install", "do not reinstall; only grant and answer prompts")
        .option("--reset-keychain", "also empty the simulator's keychain (an uninstall keeps an app's saved logins)")
        .option("--answer <s>", "how long to answer prompts after the launch", "15")
        .option("--json", "print the report as JSON")
        .action(
            async (options: {
                config?: string;
                udid?: string;
                appPath?: string;
                derivedData?: string;
                configuration: string;
                keepInstall?: boolean;
                resetKeychain?: boolean;
                answer: string;
                json?: boolean;
            }) => {
                const project = await loadProject(options);
                const ios = iosApp(project);
                const device = await pickSimulator(options.udid);
                const bundleId = ios.bundleId;
                const configuration = options.configuration === "Debug" ? "Debug" : "Release";
                const appPath =
                    options.appPath ??
                    builtAppPath(ios, options.derivedData ?? defaultDerivedData(project.appDir), configuration);

                if (!options.keepInstall) {
                    await freshInstall({ udid: device.udid, bundleId, appPath, resetKeychain: options.resetKeychain });
                }

                const preseed = await preseedFirstRun({ firstRun: ios.firstRun, udid: device.udid, bundleId });
                await terminateApp(device.udid, bundleId);
                await launchApp(device.udid, bundleId);
                const backend = await alertBackendFor({ udid: device.udid, wdaPort: wdaPortsFor(device.udid).wda });
                const appName = (await installedAppInfo(device.udid, bundleId))?.displayName ?? "";
                const watcher = backend ? new AlertWatcher({ backend, appName }) : null;
                await watcher?.answerNow({ timeoutMs: Number(options.answer) * 1000, quietMs: 4_000 });
                const report = {
                    udid: device.udid,
                    reinstalled: !options.keepInstall,
                    appPath,
                    preseed,
                    alerts: watcher?.answers ?? [],
                };

                if (options.json) {
                    out.result(report);
                    return;
                }

                ui.ok(`${report.reinstalled ? `reinstalled ${appPath}` : "kept the install"} on ${device.name}`);
                ui.info(`granted: ${[...preseed.granted, ...preseed.approved].join(", ") || "none"}`);

                for (const skipped of preseed.skipped) {
                    ui.warn(skipped);
                }

                for (const alert of report.alerts) {
                    ui.dim(
                        `alert ${alert.rule ?? "unknown"}: ${alert.tapped ? `tapped ${alert.tapped}` : "left alone"}`
                    );
                }

                if (!watcher) {
                    ui.warn("no alert backend (no WDA, no idb): prompts after the launch were not answered");
                }
            }
        );
}

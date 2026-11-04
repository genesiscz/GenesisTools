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
import { appiumPortFor, appiumStatus, startAppium, stopAppium } from "@genesiscz/utils/mobile/appium";
import { metroStatus, readMetroLogFile, stopMetro } from "@genesiscz/utils/mobile/metro";
import { installedAppInfo, launchApp, terminateApp, wdaPortsFor } from "@genesiscz/utils/mobile/simulator";
import type { Command } from "commander";
import { mobileApp } from "../apps";
import { builtAppPath, defaultDerivedData } from "../lib/build";
import { pickSimulator } from "../lib/device";
import { freshInstall, preseedFirstRun } from "../lib/first-run";
import { LOGBOX_CLEAR_MODES, readLogBoxEntries } from "../lib/logbox";
import { attachSession, ensureAppium, usesDeviceHub } from "../lib/session";
import { requireInstalled } from "../lib/tour";

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

export function registerDevice(program: Command): void {
    program
        .command("alerts <app>")
        .description(
            "Answer the system alerts on a simulator (Open in, notifications, permissions); app alerts are left alone"
        )
        .option("--udid <udid>", "the simulator; default: the only booted one")
        .option("--watch", "keep answering until Ctrl-C")
        .option("--timeout <s>", "without --watch: how long to look for alerts", "5")
        .option("--backend <kind>", `${ALERT_BACKEND_KINDS.join(" or ")} (default: WDA when it runs, else idb)`)
        .option("--json", "print the answers as JSON")
        .action(
            async (
                id: string,
                options: { udid?: string; watch?: boolean; timeout: string; backend?: string; json?: boolean }
            ) => {
                const app = mobileApp(id);
                const device = await pickSimulator(options.udid);
                const bundleId = app.bundleId(app.locate());
                const backend = await alertBackendFor({
                    udid: device.udid,
                    wdaPort: wdaPortsFor(device.udid).wda,
                    order: parseBackends(options.backend),
                });

                if (!backend) {
                    ui.err("no way to read alerts: WDA is not running (start a session) and idb is not installed");
                    ui.dim(
                        `fix: brew install idb-companion, or ${toolCommand("mobile open", app.id, "<route>")} first`
                    );
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

    program
        .command("logbox <app>")
        .description("Read React Native's LogBox (Debug builds) and Metro's errors, then minimize or clear the LogBox")
        .option("--udid <udid>", "the simulator; default: the only booted one")
        .option("--clear <mode>", `after reading: ${LOGBOX_CLEAR_MODES.join(" or ")}`, "minimize")
        .option("--metro-port <port>", "also read this Metro's log from the newest bundle on (default: the app's)")
        .option("--appium-port <port>", "the Appium server (default: the simulator's own, started when missing)")
        .option("--json", "print as JSON")
        .action(
            async (
                id: string,
                options: { udid?: string; clear: string; metroPort?: string; appiumPort?: string; json?: boolean }
            ) => {
                const clear = LOGBOX_CLEAR_MODES.find((mode) => mode === options.clear);

                if (!clear) {
                    ui.err(`--clear must be ${LOGBOX_CLEAR_MODES.join(" or ")}, not "${options.clear}"`);
                    process.exitCode = 1;
                    return;
                }

                const app = mobileApp(id);
                const device = await pickSimulator(options.udid);
                const bundleId = app.bundleId(app.locate());
                await requireInstalled(app, device.udid, bundleId);
                const port = await ensureAppium({
                    udid: device.udid,
                    port: options.appiumPort ? Number(options.appiumPort) : undefined,
                });
                const session = await attachSession({ udid: device.udid, bundleId, appiumPort: port, launch: false });
                const logbox = await readLogBoxEntries(session, { clear }).finally(() => session.close());
                const metroPort = options.metroPort ? Number(options.metroPort) : app.metro?.defaultPort;
                const metro = metroPort ? { port: metroPort, ...readMetroLogFile(metroPort) } : null;

                if (options.json) {
                    out.result({ logbox, metro });
                } else {
                    logbox.entries.length === 0
                        ? ui.ok("no LogBox entry")
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

                if (logbox.entries.length > 0 || (metro?.fatal.length ?? 0) > 0) {
                    process.exitCode = 1;
                }
            }
        );

    const appium = program.command("appium").description("Run this tool's own Appium server, one port per simulator");
    const portOf = async (options: { udid?: string; port?: string }) =>
        options.port ? Number(options.port) : appiumPortFor((await pickSimulator(options.udid)).udid);

    appium
        .command("start")
        .description("Start Appium on the simulator's port (4900 to 4999 by udid) unless one answers there")
        .option("--udid <udid>", "the simulator whose port to use")
        .option("--port <port>", "an explicit port")
        .action(async (options: { udid?: string; port?: string }) => {
            const port = await portOf(options);
            const status = await startAppium({ port, usesDeviceHub: await usesDeviceHub() });
            ui.ok(
                `appium ${status.version ?? "?"} on :${port}${status.pid ? ` (pid ${status.pid})` : " (not started by this tool)"}`
            );
            ui.dim(`log: ${status.log}`);
        });

    appium
        .command("stop")
        .description("Stop the Appium server this tool started on the port; another process's server is left running")
        .option("--udid <udid>", "the simulator whose port to use")
        .option("--port <port>", "an explicit port")
        .action(async (options: { udid?: string; port?: string }) => {
            const port = await portOf(options);
            (await stopAppium(port)) ? ui.ok(`stopped appium :${port}`) : ui.dim(`no appium of this tool on :${port}`);
        });

    appium
        .command("status")
        .description("Whether Appium answers on the port, its version, and whether this tool started it")
        .option("--udid <udid>", "the simulator whose port to use")
        .option("--port <port>", "an explicit port")
        .option("--json", "print as JSON")
        .action(async (options: { udid?: string; port?: string; json?: boolean }) => {
            const status = await appiumStatus(await portOf(options));

            if (options.json) {
                out.result(status);
                return;
            }

            status.answers
                ? ui.ok(`appium ${status.version ?? "?"} answers on :${status.port}`)
                : ui.err(`no appium on :${status.port}`);
            ui.dim(
                `owned by this tool: ${status.owned}${status.pid ? ` (pid ${status.pid})` : ""} · log ${status.log}`
            );

            if (!status.answers) {
                process.exitCode = 1;
            }
        });

    const metro = program.command("metro").description("The Metro servers `up` started");

    metro
        .command("status <port>")
        .description("Whether Metro answers on the port, and the errors it printed since its newest bundle")
        .option("--json", "print as JSON")
        .action(async (port: string, options: { json?: boolean }) => {
            const status = await metroStatus(Number(port));
            const report = readMetroLogFile(Number(port));

            if (options.json) {
                out.result({ ...status, ...report });
                return;
            }

            status.running ? ui.ok(`metro answers on :${port}`) : ui.err(`no metro on :${port}`);
            ui.dim(`owned by this tool: ${status.owned} · log ${status.log}`);

            for (const line of report.fatal) {
                ui.err(line);
            }
        });

    metro
        .command("stop <port>")
        .description("Stop the Metro this tool started on the port")
        .action(async (port: string) => {
            (await stopMetro(Number(port)))
                ? ui.ok(`stopped metro :${port}`)
                : ui.dim(`no metro of this tool on :${port}`);
        });

    program
        .command("first-run <app>")
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
            async (
                id: string,
                options: {
                    udid?: string;
                    appPath?: string;
                    derivedData?: string;
                    configuration: string;
                    keepInstall?: boolean;
                    resetKeychain?: boolean;
                    answer: string;
                    json?: boolean;
                }
            ) => {
                const app = mobileApp(id);
                const appDir = app.locate();
                const device = await pickSimulator(options.udid);
                const bundleId = app.bundleId(appDir);
                const configuration = options.configuration === "Debug" ? "Debug" : "Release";
                const appPath =
                    options.appPath ??
                    builtAppPath(app, options.derivedData ?? defaultDerivedData(appDir), configuration);

                if (!options.keepInstall) {
                    await freshInstall({ udid: device.udid, bundleId, appPath, resetKeychain: options.resetKeychain });
                }

                const preseed = await preseedFirstRun({ app, udid: device.udid, bundleId });
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

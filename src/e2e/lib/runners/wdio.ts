import { spawn } from "node:child_process";
import { appendFileSync, closeSync, existsSync, openSync, readSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { E2E_ENV } from "@genesiscz/utils/e2e/spec-env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { type AlertAnswer, type AlertBackend, AlertWatcher, alertBackendFor } from "@genesiscz/utils/mobile/alerts";
import { appiumStatus } from "@genesiscz/utils/mobile/appium";
import { iosApp, loadMobileProject } from "@genesiscz/utils/mobile/project";
import { ensureAppium, pickSimulator, requireAppInstalled } from "@genesiscz/utils/mobile/session";
import { installedAppInfo, simulatorUiRunning, wdaPortsFor } from "@genesiscz/utils/mobile/simulator";
import { type E2eRunner, numberFlag, type RunNote, stringFlag } from "./types";

const log = logger.child({ component: "e2e.wdio" });

/**
 * The app's console while the run lasts: `log stream` on the simulator for the app's process, so a failed assertion
 * has the app's own lines next to it.
 */
function streamDeviceLog(udid: string, processName: string, path: string): () => void {
    const fd = openSync(path, "a");
    const child = spawn(
        "xcrun",
        ["simctl", "spawn", udid, "log", "stream", "--style", "compact", "--predicate", `process == "${processName}"`],
        { stdio: ["ignore", fd, fd] }
    );
    closeSync(fd);
    return () => child.kill("SIGTERM");
}

function alertNote(answer: AlertAnswer): RunNote {
    const outcome = answer.tapped ? `tapped ${answer.tapped}` : "left alone";
    return {
        at: answer.at,
        source: `alert ${answer.rule ?? "unknown"} (${answer.backend})`,
        text: `${outcome}: ${answer.text.replace(/\n/g, " / ")}`,
    };
}

/**
 * Answers known system alerts for the whole run. WDA comes up with the runner's first session; until then only idb
 * can see an alert, so the watcher moves to WDA once it answers.
 */
function watchAlerts(options: {
    udid: string;
    wdaPort: number;
    appName: string;
    path: string;
}): () => Promise<RunNote[]> {
    const notes: RunNote[] = [];
    let backend: AlertBackend | null = null;
    let watcher: AlertWatcher | null = null;
    let watching = true;
    const loop = async () => {
        while (watching) {
            try {
                if (!watcher) {
                    backend = await alertBackendFor({ udid: options.udid, wdaPort: options.wdaPort });
                    watcher = backend
                        ? new AlertWatcher({
                              backend,
                              appName: options.appName,
                              onAnswer: (answer) => {
                                  notes.push(alertNote(answer));
                                  appendFileSync(options.path, `${SafeJSON.stringify(answer)}\n`);
                              },
                          })
                        : null;
                }

                await watcher?.check();

                if (backend?.kind === "idb" && (await alertBackendFor({ ...options, order: ["wda"] }))) {
                    watcher = null;
                }
            } catch (error) {
                log.debug({ error }, "alert watch tick failed");
                watcher = null;
            }

            await Bun.sleep(1_500);
        }
    };
    const done = loop();

    return async () => {
        watching = false;
        await done;
        return notes;
    };
}

/**
 * WebdriverIO with Appium on one iOS simulator: the project's `wdio.conf.ts` per spec, against the simulator's own
 * Appium (started when missing) and WebDriverAgent ports. The app comes from the project's `mobile.config.ts`. Beside
 * the specs: the app's process log (`device.log`), the Appium server's lines (`appium.log`) and the alert watcher
 * (`alerts.jsonl`).
 */
export const wdioRunner: E2eRunner<"wdio"> = {
    kind: "wdio",
    title: "WebdriverIO with Appium on an iOS simulator",
    flags: [
        { flags: "--udid <udid>", description: "wdio: the simulator; default: the only booted one" },
        {
            flags: "--appium-port <port>",
            description: "wdio: the Appium server (default: the simulator's own, started when missing)",
        },
        { flags: "--no-alert-watcher", description: "wdio: do not answer system alerts during the run" },
    ],
    async prepare({ project, runner, flags, runDir }) {
        const mobile = await loadMobileProject({
            config: runner.mobile ? resolve(project.dir, runner.mobile) : undefined,
            cwd: project.dir,
        });
        const ios = iosApp(mobile);
        const device = await pickSimulator(stringFlag(flags.udid));
        await requireAppInstalled(device.udid, ios.bundleId);
        const appiumPort = await ensureAppium({ udid: device.udid, port: numberFlag(flags.appiumPort) });
        const ports = wdaPortsFor(device.udid);
        const headless = !(await simulatorUiRunning());
        const info = await installedAppInfo(device.udid, ios.bundleId);
        const stopDeviceLog = streamDeviceLog(
            device.udid,
            info?.bundleName || ios.build.productName,
            join(runDir, "device.log")
        );
        const appium = await appiumStatus(appiumPort);
        const appiumOffset = existsSync(appium.log) ? statSync(appium.log).size : 0;
        const stopAlerts =
            flags.alertWatcher === false
                ? async () => []
                : watchAlerts({
                      udid: device.udid,
                      wdaPort: ports.wda,
                      appName: info?.displayName ?? "",
                      path: join(runDir, "alerts.jsonl"),
                  });
        const config = resolve(project.dir, runner.config);
        log.info(
            { udid: device.udid, appiumPort, wda: ports.wda, bundleId: ios.bundleId, config },
            "wdio run prepared"
        );

        return {
            facts: {
                device: `${device.name} (${device.udid}, iOS ${device.osVersion})`,
                appium: `:${appiumPort}`,
                wda: `:${ports.wda}`,
                app: ios.bundleId,
            },
            environment: {
                [E2E_ENV.udid]: device.udid,
                [E2E_ENV.deviceName]: device.name,
                [E2E_ENV.deviceOs]: device.osVersion,
                [E2E_ENV.appiumPort]: String(appiumPort),
                [E2E_ENV.wdaPort]: String(ports.wda),
                [E2E_ENV.mjpegPort]: String(ports.mjpeg),
                [E2E_ENV.bundleId]: ios.bundleId,
                [E2E_ENV.headless]: headless ? "1" : "0",
            },
            command: (spec) => ["bunx", "wdio", "run", config, "--spec", spec.file],
            async finish() {
                const notes = await stopAlerts();
                stopDeviceLog();

                if (existsSync(appium.log)) {
                    const size = statSync(appium.log).size;
                    const start = Math.max(size < appiumOffset ? 0 : appiumOffset, size - 16 * 1024 * 1024);
                    const buffer = Buffer.alloc(size - start);
                    const fd = openSync(appium.log, "r");

                    try {
                        const bytes = readSync(fd, buffer, 0, buffer.length, start);
                        writeFileSync(join(runDir, "appium.log"), buffer.subarray(0, bytes));
                    } finally {
                        closeSync(fd);
                    }
                }

                return notes;
            },
        };
    },
};

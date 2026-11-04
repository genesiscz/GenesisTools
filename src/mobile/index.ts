#!/usr/bin/env bun

import { runTool } from "@genesiscz/utils/cli";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { ui } from "@genesiscz/utils/cli/ui";
import { out } from "@genesiscz/utils/logger";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { Command } from "commander";
import { MOBILE_APPS, mobileApp } from "./apps";
import { registerDevice } from "./commands/device";
import { registerE2e } from "./commands/e2e";
import { registerScreens } from "./commands/screens";
import { registerUp } from "./commands/up";
import { buildAndInstall } from "./lib/build";
import { pickSimulator } from "./lib/device";
import { mobileDoctor } from "./lib/doctor";
import { stamp } from "./lib/paths";
import { SCREEN_DRIVERS } from "./lib/screen-driver";
import { runTour } from "./lib/tour";
import { IOS_CONFIGURATIONS, type IosBuild } from "./lib/types";

const program = new Command()
    .name("mobile")
    .description("Build, install and screenshot the mobile apps of this repo on an iOS simulator (Xcode 27 aware)");

function parseConfiguration(value: string | undefined): IosBuild["configuration"] | undefined {
    if (value === undefined) {
        return undefined;
    }

    const match = IOS_CONFIGURATIONS.find((name) => name.toLowerCase() === value.toLowerCase());

    if (!match) {
        throw new Error(`--configuration must be ${IOS_CONFIGURATIONS.join(" or ")}, not "${value}"`);
    }

    return match;
}

program
    .command("doctor")
    .description(
        "Check Xcode, the simulator UI (Simulator or DeviceHub), the XCUITest driver, Appium and booted devices"
    )
    .option("--appium-port <port>", "the Appium port to probe", "4723")
    .option("--json", "print the report as JSON")
    .action(async (options: { appiumPort: string; json?: boolean }) => {
        const report = await mobileDoctor(Number(options.appiumPort));

        if (options.json) {
            out.result(report);
            return;
        }

        for (const check of report.checks) {
            const line = `${check.name}: ${check.detail}`;
            check.ok ? ui.ok(line) : ui.err(line);

            if (check.fix) {
                ui.dim(`  fix: ${check.fix}`);
            }
        }

        for (const device of report.booted) {
            ui.dim(`  ${device.name} (iOS ${device.osVersion}) ${device.udid} · WDA port ${device.wdaPort}`);
        }

        if (report.checks.some((check) => !check.ok)) {
            process.exitCode = 1;
        }
    });

program
    .command("apps")
    .description("List the apps this tool knows")
    .option("--json", "print as JSON")
    .action((options: { json?: boolean }) => {
        const apps = Object.values(MOBILE_APPS).map((app) => ({
            id: app.id,
            title: app.title,
            dir: app.locate(),
            routes: app.routes(app.locate()).length,
        }));

        if (options.json) {
            out.result(apps);
            return;
        }

        for (const app of apps) {
            ui.info(`${app.id}: ${app.title} · ${app.routes} screens · ${app.dir}`);
        }
    });

program
    .command("routes <app>")
    .description("List an app's screens and the deep link that opens each")
    .option("--json", "print as JSON")
    .action((id: string, options: { json?: boolean }) => {
        const app = mobileApp(id);
        const routes = app.routes(app.locate());

        if (options.json) {
            out.result(routes);
            return;
        }

        for (const [index, route] of routes.entries()) {
            ui.info(`${String(index + 1).padStart(2, "0")} ${route.name}  ${route.url}`);
        }
    });

program
    .command("build <app>")
    .description("Build the app with xcodebuild for one simulator and install it (Expo run:ios fails on DeviceHub)")
    .option("--udid <udid>", "the simulator; default: the only booted one")
    .option("--no-install", "build only")
    .option("--derived-data <dir>", "the DerivedData folder; default <app>/ios/build (give each session its own)")
    .option("--configuration <name>", "Debug (loads JS from Metro) or Release (JS inside the app); default: the app's")
    .action(
        async (
            id: string,
            options: { udid?: string; install: boolean; derivedData?: string; configuration?: string }
        ) => {
            const app = mobileApp(id);
            const device = await pickSimulator(options.udid, { booted: options.install });
            ui.info(`building ${app.title} for ${device.name} (${device.udid}); this takes minutes`);
            const result = await buildAndInstall({
                app,
                appDir: app.locate(),
                udid: device.udid,
                logDir: toolDataDir("mobile", "builds"),
                install: options.install,
                derivedData: options.derivedData,
                configuration: parseConfiguration(options.configuration),
            });
            ui.ok(`built in ${result.seconds} s: ${result.appPath}${options.install ? " (installed)" : ""}`);
            ui.dim(`log: ${result.logPath}`);
        }
    );

program
    .command("tour <app>")
    .description("Open every screen by its deep link and save one screenshot per screen")
    .option("--udid <udid>", "the simulator; default: the only booted one")
    .option("--out <dir>", "the folder for the PNGs; default: ~/.genesis-tools/mobile/tours/<app>/<time>")
    .option("--settle <ms>", "the pause after each link before the screenshot, in milliseconds", "2500")
    .option(
        "--driver <driver>",
        `how to open each screen: ${SCREEN_DRIVERS.join(" or ")} (simctl shows an "Open in" alert)`,
        "appium"
    )
    .option(
        "--appium-port <port>",
        "the Appium server for --driver appium (default: the simulator's own, started when missing)"
    )
    .option("--only <names...>", `only these route names (see: ${toolCommand("mobile routes <app>")})`)
    .option("--json", "print the shots as JSON")
    .action(
        async (
            id: string,
            options: {
                udid?: string;
                out?: string;
                settle: string;
                driver: string;
                appiumPort?: string;
                only?: string[];
                json?: boolean;
            }
        ) => {
            const driver = SCREEN_DRIVERS.find((kind) => kind === options.driver);

            if (!driver) {
                ui.err(`--driver must be ${SCREEN_DRIVERS.join(" or ")}, not "${options.driver}"`);
                process.exitCode = 1;
                return;
            }

            const app = mobileApp(id);
            const device = await pickSimulator(options.udid);
            const outDir = options.out ?? toolDataDir("mobile", "tours", app.id, stamp());
            const shots = await runTour({
                app,
                appDir: app.locate(),
                udid: device.udid,
                outDir,
                settleMs: Number(options.settle),
                driver,
                appiumPort: options.appiumPort ? Number(options.appiumPort) : undefined,
                only: options.only,
                onShot: (shot, index, total) => {
                    const label = `${index + 1}/${total} ${shot.route.name}`;
                    shot.file ? ui.ok(label) : ui.err(`${label}: ${shot.error}`);
                },
            });

            if (options.json) {
                out.result({ outDir, shots });
            } else {
                ui.info(`${shots.filter((shot) => shot.file).length} of ${shots.length} screens saved in ${outDir}`);
                ui.dim(`open ${outDir}`);
            }

            if (shots.some((shot) => shot.error)) {
                process.exitCode = 1;
            }
        }
    );

registerUp(program);
registerScreens(program);
registerDevice(program);
registerE2e(program);

await runTool(program, { tool: "mobile" });

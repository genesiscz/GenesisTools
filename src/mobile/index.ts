#!/usr/bin/env bun

import { runTool } from "@genesiscz/utils/cli";
import { ui } from "@genesiscz/utils/cli/ui";
import { out } from "@genesiscz/utils/logger";
import { IOS_CONFIGURATIONS, type IosConfiguration, projectRoutes } from "@genesiscz/utils/mobile/project";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { Command } from "commander";
import { registerAppCommands } from "./commands/app";
import { registerDevices } from "./commands/devices";
import { registerRelease } from "./commands/release";
import { registerScreens } from "./commands/screens";
import { registerServices } from "./commands/services";
import { registerUp } from "./commands/up";
import { buildAndInstall } from "./lib/build";
import { pickSimulator } from "./lib/device";
import { mobileDoctor } from "./lib/doctor";
import { loadProject, type ProjectOptions, withConfig } from "./lib/project";

const program = new Command()
    .name("mobile")
    .description(
        "Drive a project's app on iOS simulators (build, install, open and capture screens; Xcode 27 aware) and on Android emulators and devices. The app comes from the project's mobile.config.ts"
    );

function parseConfiguration(value: string | undefined): IosConfiguration | undefined {
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

withConfig(program.command("config").description("Show the project config this folder resolves to"))
    .option("--json", "print as JSON")
    .action(async (options: ProjectOptions & { json?: boolean }) => {
        const project = await loadProject(options);
        const summary = {
            configPath: project.configPath,
            id: project.config.id,
            title: project.config.title ?? project.config.id,
            appDir: project.appDir,
            platforms: Object.keys(project.config.platforms),
            routes: projectRoutes(project).length,
        };

        if (options.json) {
            out.result(summary);
            return;
        }

        ui.info(`${summary.title} (${summary.id}) · ${summary.configPath}`);
        ui.dim(
            `app folder ${summary.appDir} · platforms ${summary.platforms.join(", ") || "none"} · ${summary.routes} screens`
        );
    });

withConfig(program.command("routes").description("List the project's screens and the deep link that opens each"))
    .option("--json", "print as JSON")
    .action(async (options: ProjectOptions & { json?: boolean }) => {
        const routes = projectRoutes(await loadProject(options));

        if (options.json) {
            out.result(routes);
            return;
        }

        if (routes.length === 0) {
            ui.warn("the project names no routes (routes in its mobile.config.ts)");
        }

        for (const [index, route] of routes.entries()) {
            ui.info(`${String(index + 1).padStart(2, "0")} ${route.name}  ${route.url}`);
        }
    });

withConfig(
    program
        .command("build")
        .description(
            "Build the iOS app with xcodebuild for one simulator and install it (Expo run:ios fails on DeviceHub)"
        )
)
    .option("--udid <udid>", "the simulator; default: the only booted one")
    .option("--no-install", "build only")
    .option("--derived-data <dir>", "the DerivedData folder; default <app>/ios/build (give each session its own)")
    .option(
        "--configuration <name>",
        "Debug (loads JS from Metro) or Release (JS inside the app); default: the project's"
    )
    .action(
        async (
            options: ProjectOptions & { udid?: string; install: boolean; derivedData?: string; configuration?: string }
        ) => {
            const project = await loadProject(options);
            const device = await pickSimulator(options.udid, { booted: options.install });
            ui.info(
                `building ${project.config.title ?? project.config.id} for ${device.name} (${device.udid}); this takes minutes`
            );
            const result = await buildAndInstall({
                project,
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

registerUp(program);
registerScreens(program);
registerAppCommands(program);
registerServices(program);
registerDevices(program);
registerRelease(program);

await runTool(program, { tool: "mobile" });

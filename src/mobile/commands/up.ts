import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { ui } from "@genesiscz/utils/cli/ui";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { mobileApp } from "../apps";
import { defaultDerivedData } from "../lib/build";
import { BUILD_POLICIES, type BuildPolicy, bringUp } from "../lib/up";

interface UpOptions {
    udid?: string;
    name?: string;
    width?: string;
    os?: string;
    release?: boolean;
    derivedData?: string;
    build: string;
    metroPort?: string;
    launchTimeout: string;
    json?: boolean;
}

export function registerUp(program: Command): void {
    program
        .command("up <app>")
        .description(
            "Boot (or create) a simulator sized for a width, build when stale, install, start Metro and launch the app"
        )
        .option("--udid <udid>", "use this simulator instead of finding one by name")
        .option("--name <name>", "the simulator's name; created when missing (default gt-w<width>)")
        .option("--width <points>", "the phone width in points (default: the app's)")
        .option("--os <version>", "the iOS runtime for a new simulator, e.g. 26.5 (default: the newest)")
        .option("--release", "run the Release build (JavaScript inside the app, no Metro)")
        .option("--derived-data <dir>", "the DerivedData folder (default <app>/ios/build; give each session its own)")
        .option("--build <when>", `${BUILD_POLICIES.join(" | ")}: auto builds only when a build input changed`, "auto")
        .option("--metro-port <port>", "the Metro port for a Debug build (default: the app's)")
        .option("--launch-timeout <s>", "how long to wait for the app to fetch its bundle", "180")
        .option("--json", "print the report as JSON")
        .action(async (id: string, options: UpOptions) => {
            const build = BUILD_POLICIES.find((policy) => policy === options.build);

            if (!build) {
                ui.err(`--build must be ${BUILD_POLICIES.join(" or ")}, not "${options.build}"`);
                process.exitCode = 1;
                return;
            }

            const app = mobileApp(id);
            const appDir = app.locate();
            const report = await bringUp({
                app,
                appDir,
                udid: options.udid,
                name: options.name,
                width: options.width ? Number(options.width) : app.defaultWidth,
                os: options.os,
                configuration: options.release || !app.metro ? "Release" : "Debug",
                derivedData: options.derivedData ?? defaultDerivedData(appDir),
                build: build satisfies BuildPolicy,
                metroPort: options.metroPort ? Number(options.metroPort) : undefined,
                launchTimeoutMs: Number(options.launchTimeout) * 1000,
                onStep: options.json ? undefined : (message) => ui.info(message),
            });

            if (options.json) {
                out.result(report);
            } else {
                for (const skipped of report.preseed.skipped) {
                    ui.warn(`first run: ${skipped}`);
                }

                for (const alert of report.alerts) {
                    ui.dim(
                        `alert ${alert.rule ?? "unknown"}: ${alert.tapped ? `tapped ${alert.tapped}` : "left alone"}`
                    );
                }

                if (report.metro) {
                    report.appRan
                        ? ui.ok(`the app runs on Metro :${report.metro.port}`)
                        : ui.err(
                              `the app did not fetch its bundle from Metro :${report.metro.port}; read ${report.metro.log}`
                          );
                }

                for (const line of report.fatal) {
                    ui.err(`metro: ${line}`);
                }

                const udid = report.device.udid;
                ui.dim(`appium :${report.appiumPort} · wda :${report.wdaPort}`);
                ui.dim(`next: ${toolCommand("mobile open", app.id, "<route>", "--udid", udid)}`);
                ui.dim(`      ${toolCommand("mobile e2e suite", app.id, "flows", "--udid", udid)}`);
            }

            if (report.fatal.length > 0 || report.appRan === false) {
                process.exitCode = 1;
            }
        });
}

import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { ui } from "@genesiscz/utils/cli/ui";
import { out } from "@genesiscz/utils/logger";
import { iosApp } from "@genesiscz/utils/mobile/project";
import type { Command } from "commander";
import { defaultDerivedData } from "../lib/build";
import { loadProject, type ProjectOptions, withConfig } from "../lib/project";
import { BUILD_POLICIES, type BuildPolicy, bringUp } from "../lib/up";

interface UpOptions extends ProjectOptions {
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
    withConfig(
        program
            .command("up")
            .description(
                "Boot (or create) a simulator sized for a width, build when stale, install, start Metro and launch the app"
            )
    )
        .option("--udid <udid>", "use this simulator instead of finding one by name")
        .option("--name <name>", "the simulator's name; created when missing (default gt-w<width>)")
        .option(
            "--width <points>",
            "the phone width in points (default: platforms.ios.defaultWidth)",
            (value: string) => {
                const n = Number(value);
                if (!Number.isFinite(n) || n <= 0) {
                    throw new Error("--width must be finite and positive");
                }
                return value;
            }
        )
        .option("--os <version>", "the iOS runtime for a new simulator, e.g. 26.5 (default: the newest)")
        .option("--release", "run the Release build (JavaScript inside the app, no Metro)")
        .option("--derived-data <dir>", "the DerivedData folder (default <app>/ios/build; give each session its own)")
        .option("--build <when>", `${BUILD_POLICIES.join(" | ")}: auto builds only when a build input changed`, "auto")
        .option("--metro-port <port>", "the Metro port for a Debug build (default: the project's)", (value: string) => {
            const n = Number(value);
            if (!Number.isFinite(n) || n <= 0) {
                throw new Error("--metro-port must be finite and positive");
            }
            return value;
        })
        .option(
            "--launch-timeout <s>",
            "how long to wait for the app to fetch its bundle",
            (value: string) => {
                const n = Number(value);
                if (!Number.isFinite(n) || n <= 0) {
                    throw new Error("--launch-timeout must be finite and positive");
                }
                return value;
            },
            "180"
        )
        .option("--json", "print the report as JSON")
        .action(async (options: UpOptions) => {
            const build = BUILD_POLICIES.find((policy) => policy === options.build);

            if (!build) {
                ui.err(`--build must be ${BUILD_POLICIES.join(" or ")}, not "${options.build}"`);
                process.exitCode = 1;
                return;
            }

            const project = await loadProject(options);
            const width = options.width ? Number(options.width) : iosApp(project).defaultWidth;

            if (!width) {
                ui.err(`pass --width <points>, or set platforms.ios.defaultWidth in ${project.configPath}`);
                process.exitCode = 1;
                return;
            }

            const report = await bringUp({
                project,
                udid: options.udid,
                name: options.name,
                width,
                os: options.os,
                configuration: options.release || !project.config.metro ? "Release" : "Debug",
                derivedData: options.derivedData ?? defaultDerivedData(project.appDir),
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
                ui.dim(`next: ${toolCommand("mobile open", "<route>", "--udid", udid)}`);
                ui.dim(`      ${toolCommand("mobile capture", "<route>", "--udid", udid)}`);
            }

            if (report.fatal.length > 0 || report.appRan === false) {
                process.exitCode = 1;
            }
        });
}

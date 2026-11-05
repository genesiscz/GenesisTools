import { suggestEnumFlag } from "@genesiscz/utils/cli";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { ui } from "@genesiscz/utils/cli/ui";
import { out } from "@genesiscz/utils/logger";
import { captureScreen } from "@genesiscz/utils/mobile/capture";
import { iosApp, projectRoutes } from "@genesiscz/utils/mobile/project";
import { openScreenDriver, parseScreenDriver, SCREEN_DRIVERS } from "@genesiscz/utils/mobile/screen-driver";
import { pickSimulator, requireAppInstalled } from "@genesiscz/utils/mobile/session";
import type { Command } from "commander";
import { runDirFor } from "../lib/paths";
import { loadProject, type ProjectOptions, withConfig } from "../lib/project";
import { projectRoute, selectRoutes } from "../lib/routes";
import { runTour } from "../lib/tour";

interface ScreenOptions extends ProjectOptions {
    udid?: string;
    driver: string;
    appiumPort?: string;
    settle: string;
    json?: boolean;
}

function driverOptions(command: Command, settle: string): Command {
    return withConfig(command)
        .option("--udid <udid>", "the simulator; default: the only booted one")
        .option(
            "--driver [driver]",
            `${SCREEN_DRIVERS.join(" or ")}`,
            (value: string) => {
                if (!SCREEN_DRIVERS.some((kind) => kind === value)) {
                    throw new Error(suggestEnumFlag("tools mobile", "--driver", SCREEN_DRIVERS));
                }
                return value;
            },
            "appium"
        )
        .option(
            "--appium-port <port>",
            "the Appium server (default: the simulator's own, started when missing)",
            (value: string) => {
                const n = Number(value);
                if (!Number.isFinite(n) || n <= 0) {
                    throw new Error("--appium-port must be positive");
                }
                return value;
            }
        )
        .option(
            "--settle <ms>",
            "the pause after the screen's root shows, in milliseconds",
            (value: string) => {
                const n = Number(value);
                if (!Number.isFinite(n) || n < 0) {
                    throw new Error("--settle must be nonnegative");
                }
                return value;
            },
            settle
        );
}

async function openDriver(options: ScreenOptions) {
    const project = await loadProject(options);
    const device = await pickSimulator(options.udid);
    const { bundleId } = iosApp(project);
    await requireAppInstalled(device.udid, bundleId);
    const driver = await openScreenDriver(parseScreenDriver(options.driver), {
        udid: device.udid,
        bundleId,
        settleMs: Number(options.settle),
        appiumPort: options.appiumPort ? Number(options.appiumPort) : undefined,
    });
    return { project, device, driver };
}

export function registerScreens(program: Command): void {
    driverOptions(
        program
            .command("open <route>")
            .description(
                'Open one screen by its deep link (a route name, name?query, or a URL) with no "Open in" alert'
            ),
        "1500"
    )
        .option("--json", "print the result as JSON")
        .action(async (target: string, options: ScreenOptions) => {
            // An unknown route fails before a device session is taken.
            const route = projectRoute(await loadProject(options), target);
            const { device, driver } = await openDriver(options);

            try {
                await driver.open(route);
            } finally {
                await driver.close();
            }

            options.json
                ? out.result({ udid: device.udid, route })
                : ui.ok(`${route.name} open on ${device.name}${route.rootId ? ` (#${route.rootId} showed)` : ""}`);
        });

    driverOptions(
        program
            .command("capture [route]")
            .description("Save one screen's screenshot and its accessibility tree (XML, readable tree, JSON summary)"),
        "1500"
    )
        .option("--out <dir>", "the folder (default ~/.genesis-tools/mobile/captures/<project>/<time>)")
        .option("--name <name>", "the file name stem (default: the route name, or screen)")
        .option("--json", "print the result as JSON")
        .action(async (target: string | undefined, options: ScreenOptions & { out?: string; name?: string }) => {
            // An unknown route fails before a device session is taken.
            const route = target ? projectRoute(await loadProject(options), target) : undefined;
            const { project, driver } = await openDriver(options);
            const outDir = options.out ?? runDirFor("captures", project.config.id);

            try {
                if (route) {
                    await driver.open(route);
                }

                const result = await captureScreen({
                    driver,
                    outDir,
                    name: options.name ?? route?.name ?? "screen",
                    route,
                });

                if (options.json) {
                    out.result(result);
                    return;
                }

                ui.ok(`screenshot ${result.files.png}`);
                result.files.tree
                    ? ui.ok(`tree ${result.files.tree}`)
                    : ui.warn("no tree: this driver cannot read it now");

                if (result.summary) {
                    ui.dim(
                        `${result.summary.elements} elements · ${result.summary.testIds.length} testIDs · ${result.summary.buttons.length} tap targets`
                    );

                    for (const alert of result.summary.alerts) {
                        ui.warn(`alert open: ${alert}`);
                    }
                }

                if (result.logbox && result.logbox !== "none") {
                    ui.warn(`a LogBox is ${result.logbox}; read it: ${toolCommand("mobile logbox")}`);
                }
            } finally {
                await driver.close();
            }
        });

    driverOptions(
        program.command("tour").description("Open every screen by its deep link and save one screenshot per screen"),
        "2500"
    )
        .option("--out <dir>", "the folder for the PNGs (default ~/.genesis-tools/mobile/tours/<project>/<time>)")
        .option("--only <names...>", `only these route names (see: ${toolCommand("mobile routes")})`)
        .option("--json", "print the shots as JSON")
        .action(async (options: ScreenOptions & { out?: string; only?: string[] }) => {
            const project = await loadProject(options);
            const routes = selectRoutes(projectRoutes(project), options.only);
            const device = await pickSimulator(options.udid);
            const outDir = options.out ?? runDirFor("tours", project.config.id);
            const shots = await runTour({
                routes,
                udid: device.udid,
                bundleId: iosApp(project).bundleId,
                outDir,
                settleMs: Number(options.settle),
                driver: parseScreenDriver(options.driver),
                appiumPort: options.appiumPort ? Number(options.appiumPort) : undefined,
                onShot: (shot, index, total) => {
                    const label = `${index + 1}/${total} ${shot.route.name}`;
                    shot.file ? ui.ok(label) : ui.err(`${label}: ${shot.error}`);
                },
            });

            if (options.json) {
                out.result({ outDir, shots });
            } else {
                ui.info(`${shots.filter((shot) => shot.file).length} of ${shots.length} screens saved in ${outDir}`);
            }

            if (shots.some((shot) => shot.error)) {
                process.exitCode = 1;
            }
        });
}

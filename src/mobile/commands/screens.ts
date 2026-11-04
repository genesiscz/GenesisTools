import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { ui } from "@genesiscz/utils/cli/ui";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { mobileApp } from "../apps";
import { captureScreen } from "../lib/capture";
import { pickSimulator } from "../lib/device";
import { runDirFor } from "../lib/paths";
import { resolveRoute } from "../lib/routes";
import { openScreenDriver, parseScreenDriver, SCREEN_DRIVERS } from "../lib/screen-driver";
import { requireInstalled } from "../lib/tour";

interface ScreenOptions {
    udid?: string;
    driver: string;
    appiumPort?: string;
    settle: string;
    json?: boolean;
}

function driverOptions(command: Command): Command {
    return command
        .option("--udid <udid>", "the simulator; default: the only booted one")
        .option("--driver <driver>", `${SCREEN_DRIVERS.join(" or ")} (simctl raises an "Open in" alert)`, "appium")
        .option("--appium-port <port>", "the Appium server (default: the simulator's own, started when missing)")
        .option("--settle <ms>", "the pause after the screen's root shows", "1500");
}

async function openDriver(id: string, options: ScreenOptions) {
    const app = mobileApp(id);
    const appDir = app.locate();
    const device = await pickSimulator(options.udid);
    const bundleId = app.bundleId(appDir);
    await requireInstalled(app, device.udid, bundleId);
    const driver = await openScreenDriver(parseScreenDriver(options.driver), {
        udid: device.udid,
        bundleId,
        settleMs: Number(options.settle),
        appiumPort: options.appiumPort ? Number(options.appiumPort) : undefined,
    });
    return { app, appDir, device, driver };
}

export function registerScreens(program: Command): void {
    driverOptions(
        program
            .command("open <app> <route>")
            .description(
                'Open one screen by its deep link (a route name, name?query, or a URL) with no "Open in" alert'
            )
    )
        .option("--json", "print the result as JSON")
        .action(async (id: string, target: string, options: ScreenOptions) => {
            const { app, appDir, device, driver } = await openDriver(id, options);
            const route = resolveRoute(app, appDir, target);

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
            .command("capture <app> [route]")
            .description("Save one screen's screenshot and its accessibility tree (XML, readable tree, JSON summary)")
    )
        .option("--out <dir>", "the folder (default ~/.genesis-tools/mobile/captures/<time>)")
        .option("--name <name>", "the file name stem (default: the route name, or screen)")
        .option("--json", "print the result as JSON")
        .action(
            async (
                id: string,
                target: string | undefined,
                options: ScreenOptions & { out?: string; name?: string }
            ) => {
                const { app, appDir, driver } = await openDriver(id, options);
                const route = target ? resolveRoute(app, appDir, target) : undefined;
                const outDir = options.out ?? runDirFor("captures");

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
                        ui.warn(`a LogBox is ${result.logbox}; read it: ${toolCommand("mobile logbox", app.id)}`);
                    }
                } finally {
                    await driver.close();
                }
            }
        );
}

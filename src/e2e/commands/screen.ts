import { resolve } from "node:path";
import { ui } from "@genesiscz/utils/cli/ui";
import { out } from "@genesiscz/utils/logger";
import { findById, parseSource } from "@genesiscz/utils/mobile/a11y";
import { captureScreen } from "@genesiscz/utils/mobile/capture";
import { iosApp, loadMobileProject, projectRoutes, resolveRoute } from "@genesiscz/utils/mobile/project";
import { openScreenDriver, RootMissingError } from "@genesiscz/utils/mobile/screen-driver";
import { pickSimulator, requireAppInstalled } from "@genesiscz/utils/mobile/session";
import type { Command } from "commander";
import { newRunDir } from "../lib/paths";
import { loadProject, type ProjectOptions, withConfig } from "../lib/project";

interface ScreenOptions extends ProjectOptions {
    mobile?: string;
    udid?: string;
    appiumPort?: string;
    expect?: string[];
    out?: string;
    json?: boolean;
}

/**
 * `screen <route>`: one screen of a mobile project, checked without a spec: its root shows, the expected testIDs are
 * there, and no LogBox or alert covers it. The app comes from the mobile.config.ts beside the e2e config.
 */
export function registerScreen(program: Command): void {
    withConfig(
        program
            .command("screen <route>")
            .description(
                "Open one screen of a mobile project, check its root, testIDs, LogBox and alerts, save its capture"
            )
    )
        .option("--mobile <file>", "the app's mobile.config.ts (default: the nearest one at or above the e2e config)")
        .option("--udid <udid>", "the simulator; default: the only booted one")
        .option("--appium-port <port>", "the Appium server (default: the simulator's own, started when missing)")
        .option("--expect <id>", "repeat for each expected testID", (value: string, previous: string[] = []) => [
            ...previous,
            value,
        ])
        .option("--out <dir>", "the folder (default ~/.genesis-tools/e2e/runs/<project>/<time>)")
        .option("--json", "print the result as JSON")
        .action(async (target: string, options: ScreenOptions) => {
            const project = await loadProject(options);
            const mobile = await loadMobileProject({
                config: options.mobile
                    ? resolve(options.mobile)
                    : project.config.runner.kind === "wdio" && project.config.runner.mobile
                      ? resolve(project.dir, project.config.runner.mobile)
                      : undefined,
                cwd: project.dir,
            });
            const { bundleId } = iosApp(mobile);
            const device = await pickSimulator(options.udid);
            await requireAppInstalled(device.udid, bundleId);
            const route = resolveRoute(projectRoutes(mobile), target);
            const driver = await openScreenDriver("appium", {
                udid: device.udid,
                bundleId,
                settleMs: 1_500,
                appiumPort: options.appiumPort ? Number(options.appiumPort) : undefined,
            });
            const problems: string[] = [];
            const outDir = options.out ?? newRunDir(project.config.id);

            try {
                try {
                    await driver.open(route);
                } catch (error) {
                    if (!(error instanceof RootMissingError)) {
                        throw error;
                    }

                    problems.push(error.message);
                }

                const capture = await captureScreen({ driver, outDir, name: route.name, route });
                const nodes = parseSource(capture.files.xml ? await Bun.file(capture.files.xml).text() : "");

                for (const expected of options.expect ?? []) {
                    if (!findById(nodes, expected)) {
                        problems.push(`#${expected} is not on the screen`);
                    }
                }

                if (capture.logbox && capture.logbox !== "none") {
                    problems.push(`a LogBox is ${capture.logbox} over the screen`);
                }

                for (const alert of capture.summary?.alerts ?? []) {
                    problems.push(`an alert is open: ${alert}`);
                }

                if (options.json) {
                    out.result({ route, ok: problems.length === 0, problems, ...capture });
                } else {
                    if (problems.length === 0) {
                        ui.ok(`${route.name} shows`);
                    }

                    for (const problem of problems) {
                        ui.err(problem);
                    }

                    ui.dim(`tree: ${capture.files.tree ?? "(none)"} · screenshot: ${capture.files.png}`);
                    ui.dim(`texts: ${(capture.summary?.texts ?? []).slice(0, 20).join(" · ")}`);
                }
            } finally {
                await driver.close();
            }

            if (problems.length > 0) {
                process.exitCode = 1;
            }
        });
}

import { ui } from "@genesiscz/utils/cli/ui";
import { out } from "@genesiscz/utils/logger";
import { appiumPortFor, appiumStatus, startAppium, stopAppium } from "@genesiscz/utils/mobile/appium";
import { metroStatus, readMetroLogFile, stopMetro } from "@genesiscz/utils/mobile/metro";
import { pickSimulator, usesDeviceHub } from "@genesiscz/utils/mobile/session";
import type { Command } from "commander";

/** `appium start|stop|status` and `metro status|stop`: the background servers this tool owns, one per port. */
export function registerServices(program: Command): void {
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

    const metro = program.command("metro").description("The Metro servers this tool started");

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
}

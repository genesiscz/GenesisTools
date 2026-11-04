import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { ui } from "@genesiscz/utils/cli/ui";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { chooseDevice, choosePlatform, PLATFORM_IDS, PLATFORMS } from "../lib/platforms";
import type { MobileDevice } from "../lib/platforms/types";
import { loadOptionalProject, loadProject, type ProjectOptions, withConfig } from "../lib/project";
import { projectRoute } from "../lib/routes";

interface DeviceOptions extends ProjectOptions {
    platform?: string;
    device?: string;
    json?: boolean;
}

function deviceOptions(command: Command): Command {
    return withConfig(command)
        .option("--platform <name>", `${PLATFORM_IDS.join(" or ")} (default: the project's only platform)`)
        .option("--device <id>", "the udid or adb serial; default: the only booted device of the platform");
}

async function target(options: DeviceOptions, needsProject: boolean) {
    const project = needsProject ? await loadProject(options) : await loadOptionalProject(options);
    const platform = choosePlatform(options.platform, project);
    const device = chooseDevice(await platform.listDevices(), options.device);
    return { project, platform, device };
}

async function appTarget(options: DeviceOptions) {
    const { project, platform, device } = await target(options, true);

    if (!project) {
        throw new Error("this command needs a project config");
    }

    return { project, platform, device, app: platform.app(project) };
}

function describe(device: MobileDevice): string {
    const os = device.osVersion ? ` ${PLATFORMS[device.platform].osName} ${device.osVersion}` : "";
    return `${device.name} (${device.kind}${os}) ${device.id} · ${device.rawState}`;
}

/**
 * Device control on either platform (iOS simulators through simctl, Android emulators and devices through adb), all
 * through the `PLATFORMS` table.
 */
export function registerDevices(program: Command): void {
    withConfig(program.command("devices").description("List simulators, emulators and devices of every platform"))
        .option("--platform <name>", `only ${PLATFORM_IDS.join(" or ")}`)
        .option("--json", "print as JSON")
        .action(async (options: DeviceOptions) => {
            const platforms = options.platform ? [choosePlatform(options.platform, null)] : Object.values(PLATFORMS);
            const results = await Promise.allSettled(platforms.map((platform) => platform.listDevices()));
            const devices = results.flatMap((result, index) => {
                if (result.status === "fulfilled") {
                    return result.value;
                }

                ui.warn(`${platforms[index].title} unavailable: ${String(result.reason)}`);
                return [];
            });

            if (options.json) {
                out.result(devices);
                return;
            }

            for (const device of devices) {
                device.state === "booted" ? ui.ok(describe(device)) : ui.dim(describe(device));
            }

            if (devices.length === 0) {
                ui.warn("no simulator, emulator or device found");
            }
        });

    withConfig(program.command("boot <device>").description("Boot a simulator (udid) or an Android AVD (its name)"))
        .option("--platform <name>", `${PLATFORM_IDS.join(" or ")} (default: the project's only platform)`)
        .option("--timeout <s>", "how long to wait until the device is ready", "300")
        .option("--json", "print the device as JSON")
        .action(async (id: string, options: DeviceOptions & { timeout: string }) => {
            const timeoutMs = Number(options.timeout) * 1000;

            if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
                throw new Error("--timeout must be a positive number of seconds");
            }

            const platform = choosePlatform(options.platform, await loadOptionalProject(options));
            const device = await platform.boot(id, { timeoutMs });
            options.json ? out.result(device) : ui.ok(`booted ${describe(device)}`);
        });

    deviceOptions(program.command("shutdown").description("Shut a simulator or an emulator down")).action(
        async (options: DeviceOptions) => {
            const { platform, device } = await target(options, false);
            await platform.shutdown(device);
            ui.ok(`shut down ${device.name} (${device.id})`);
        }
    );

    deviceOptions(
        program
            .command("install [artifact]")
            .description("Install a build (.app or .apk); default: the project's build for the platform")
    ).action(async (artifact: string | undefined, options: DeviceOptions) => {
        const { project, platform, device, app } = await appTarget(options);
        const path = artifact ? resolve(artifact) : app.artifact;

        if (!path) {
            throw new Error(`pass the build to install; ${project.configPath} names none for ${platform.id}`);
        }

        await platform.install(device, path);
        ui.ok(`installed ${path} on ${device.name}`);
    });

    deviceOptions(program.command("uninstall").description("Uninstall the project's app")).action(
        async (options: DeviceOptions) => {
            const { platform, device, app } = await appTarget(options);
            await platform.uninstall(device, app);
            ui.ok(`uninstalled ${app.id} from ${device.name}`);
        }
    );

    deviceOptions(program.command("launch").description("Start the project's app")).action(
        async (options: DeviceOptions) => {
            const { platform, device, app } = await appTarget(options);

            if (!(await platform.isInstalled(device, app))) {
                throw new Error(
                    `${app.id} is not installed on ${device.name}; install it: ${toolCommand("mobile install")}`
                );
            }

            await platform.launch(device, app);
            ui.ok(`launched ${app.id} on ${device.name}`);
        }
    );

    deviceOptions(program.command("terminate").description("Stop the project's app")).action(
        async (options: DeviceOptions) => {
            const { platform, device, app } = await appTarget(options);
            await platform.terminate(device, app);
            ui.ok(`stopped ${app.id} on ${device.name}`);
        }
    );

    deviceOptions(
        program
            .command("url <target>")
            .description("Open a route name or a URL with the platform's own link handling (no Appium)")
    ).action(async (link: string, options: DeviceOptions) => {
        const { project, platform, device, app } = await appTarget(options);
        const route = projectRoute(project, link);
        await platform.openUrl(device, route.url, /^https?:\/\//i.test(link) ? undefined : app);
        ui.ok(`opened ${route.url} on ${device.name}`);
    });

    deviceOptions(program.command("screenshot <file>").description("Save the device's screen as a PNG"))
        .option("--json", "print the result as JSON")
        .action(async (file: string, options: DeviceOptions) => {
            const { platform, device } = await target(options, false);
            const path = resolve(file);
            mkdirSync(dirname(path), { recursive: true });
            await platform.screenshot(device, path);
            options.json ? out.result({ device: device.id, file: path }) : ui.ok(path);
        });
}

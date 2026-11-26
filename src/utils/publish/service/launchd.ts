import { join } from "node:path";
import {
    bootoutLaunchd,
    installLaunchd,
    kickstartLaunchd,
    type LaunchdInstallOptions,
    launchdStatus,
    plistPath,
    renderLaunchdPlist,
    startLaunchd,
} from "@genesiscz/utils/process/launchd-agent";
import type { ShareServerConfig } from "../../genesis-tools/publish/store";
import type { ServiceInstaller, ServiceUnitInput } from "./types";

function labelFor(server: ShareServerConfig): string {
    if (server.service.manager !== "launchd") {
        throw new Error("Expected a launchd server");
    }

    return server.service.label;
}

function options({ server, checkoutDir, command, home }: ServiceUnitInput): LaunchdInstallOptions {
    return {
        label: labelFor(server),
        command,
        cwd: checkoutDir,
        env: { HOME: home, GENESIS_TOOLS_HOME: home },
        logFile: join(server.stateDir, "service.log"),
    };
}

const live = { bootoutLaunchd, installLaunchd, kickstartLaunchd, launchdStatus, plistPath, startLaunchd };

export function createLaunchdInstaller(deps: typeof live = live): ServiceInstaller & { readonly manager: "launchd" } {
    const active = async (server: ShareServerConfig) => (await deps.launchdStatus(labelFor(server))).loaded;

    return {
        manager: "launchd",
        render: (input) => renderLaunchdPlist(options(input)),
        installCommands: () => [],
        async install(input) {
            const spec = options(input);
            await deps.installLaunchd(spec, { kickstart: false });
            return { unitFile: deps.plistPath(spec.label) };
        },
        async restart(server) {
            const label = labelFor(server);
            if (!(await active(server))) {
                await deps.startLaunchd(label);
            } else if (!(await deps.kickstartLaunchd(label))) {
                throw new Error(`Could not restart launchd service "${label}"`);
            }
        },
        async stop(server) {
            const label = labelFor(server);
            await deps.bootoutLaunchd(label);
            if (await active(server)) {
                throw new Error(`Could not stop launchd service "${label}"`);
            }
        },
        isActive: active,
    };
}

export const launchdInstaller = createLaunchdInstaller();

import { homedir } from "node:os";
import { join } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import type { ShareServerConfig } from "../../genesis-tools/publish/store";
import {
    runServiceCommand,
    type ServiceInstaller,
    type ServiceRunner,
    type ServiceUnitInput,
    writeServiceFile,
} from "./types";

function labelFor(server: ShareServerConfig): string {
    if (server.service.manager !== "launchd") {
        throw new Error("Expected a launchd server");
    }

    return server.service.label;
}

function xml(value: string): string {
    return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function string(value: string): string {
    return `<string>${xml(value)}</string>`;
}

function render(input: ServiceUnitInput): string {
    const { server, checkoutDir, bunPath, home } = input;
    const program = [
        bunPath,
        join(checkoutDir, "src/dev-dashboard/index.ts"),
        "share-server",
        "serve",
        "--server",
        server.name,
    ];
    return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0">',
        "<dict>",
        `  <key>Label</key>${string(labelFor(server))}`,
        "  <key>ProgramArguments</key>",
        "  <array>",
        ...program.map((arg) => `    ${string(arg)}`),
        "  </array>",
        `  <key>WorkingDirectory</key>${string(checkoutDir)}`,
        "  <key>EnvironmentVariables</key>",
        "  <dict>",
        `    <key>HOME</key>${string(home)}`,
        `    <key>GENESIS_TOOLS_HOME</key>${string(home)}`,
        "  </dict>",
        "  <key>KeepAlive</key><true/>",
        "</dict>",
        "</plist>",
        "",
    ].join("\n");
}

export function createLaunchdInstaller(
    deps: { root?: string; uid?: number; run?: ServiceRunner } = {}
): ServiceInstaller & { readonly manager: "launchd" } {
    const domain = `gui/${deps.uid ?? process.getuid?.() ?? 0}`;
    const run = deps.run ?? runServiceCommand;
    const serviceId = (server: ShareServerConfig) => `${domain}/${labelFor(server)}`;
    const active = async (server: ShareServerConfig): Promise<boolean> => {
        try {
            await run(["launchctl", "print", serviceId(server)]);
            return true;
        } catch (err) {
            logger.debug({ err, server: server.name }, "launchd publish service inactive");
            return false;
        }
    };

    const installCommands: ServiceInstaller["installCommands"] = ({ unitFile }) => [
        ["launchctl", "bootstrap", domain, unitFile],
    ];

    return {
        manager: "launchd",
        render,
        installCommands,
        async install(input) {
            const { server } = input;
            const unitFile = join(
                deps.root ?? join(input.home, "Library", "LaunchAgents"),
                `${labelFor(server)}.plist`
            );
            if (await active(server)) {
                await run(["launchctl", "bootout", serviceId(server)]);
            }

            await writeServiceFile(unitFile, render(input));
            for (const argv of installCommands({ ...input, unitFile })) {
                await run(argv);
            }

            return { unitFile };
        },
        async restart(server) {
            await run(["launchctl", "enable", serviceId(server)]);
            if (!(await active(server))) {
                const file = join(deps.root ?? join(homedir(), "Library", "LaunchAgents"), `${labelFor(server)}.plist`);
                await run(["launchctl", "bootstrap", domain, file]);
            }

            await run(["launchctl", "kickstart", "-k", serviceId(server)]);
        },
        stop: (server) => run(["launchctl", "bootout", serviceId(server)]),
        isActive: active,
    };
}

export const launchdInstaller = createLaunchdInstaller();

import type { ServiceManager, ShareServerConfig } from "../../genesis-tools/publish/store";
import { launchdInstaller } from "./launchd";
import { noServiceInstaller } from "./none";
import { systemdInstaller } from "./systemd";
import type { ServiceInstaller } from "./types";

export const SERVICE_INSTALLERS: {
    readonly [M in ServiceManager]: ServiceInstaller & { readonly manager: M };
} = {
    systemd: systemdInstaller,
    launchd: launchdInstaller,
    none: noServiceInstaller,
};

export function serviceFor(server: ShareServerConfig): ServiceInstaller {
    return SERVICE_INSTALLERS[server.service.manager];
}

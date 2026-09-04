import { runAiProxyInstallLaunchd, runAiProxyUninstallLaunchd } from "@app/ai-proxy/lib/lifecycle";
import { out } from "@genesiscz/utils/logger";

export async function runInstallCommand(options: { json?: boolean }): Promise<void> {
    const result = await runAiProxyInstallLaunchd();

    if (options.json) {
        out.result(result);
        return;
    }

    out.log.info(`Plist:  ${result.plistPath}`);
    out.log.info(`Port:   ${result.port}`);

    if (result.healthy) {
        out.log.success(result.message);
    } else {
        out.log.warn(result.message);
    }
}

export async function runUninstallCommand(options: { json?: boolean }): Promise<void> {
    const result = await runAiProxyUninstallLaunchd();

    if (options.json) {
        out.result(result);
        return;
    }

    if (result.removed) {
        out.log.success(result.message);
    } else {
        out.log.info(result.message);
    }
}

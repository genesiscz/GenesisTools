import { resolve } from "node:path";
import { logger, out } from "@genesiscz/utils/logger";
import { createBoxTable, formatDotStatus } from "@genesiscz/utils/table";
import {
    defaultBinDir,
    defaultCheckout,
    installLaunchers,
    isCheckout,
    type LauncherWriteResult,
    parseAccountLauncherFlag,
} from "../lib/launchers";

const { log } = logger.scoped("t3:launchers");

export interface LaunchersInstallOptions {
    binDir?: string;
    checkout?: string;
    account: string[];
    json?: boolean;
}

function statusCell(result: LauncherWriteResult): string {
    return result.status === "unchanged" ? formatDotStatus("dim", "unchanged") : formatDotStatus("ok", result.status);
}

export async function launchersInstallCommand(options: LaunchersInstallOptions): Promise<void> {
    const binDir = options.binDir ? resolve(options.binDir) : defaultBinDir();
    const checkout = options.checkout ? resolve(options.checkout) : defaultCheckout();

    if (!isCheckout(checkout)) {
        out.error(`${checkout} has no runnable tools entry point.`);
        process.exitCode = 1;
        return;
    }

    const accounts = options.account.map(parseAccountLauncherFlag);
    log.debug({ binDir, checkout, accounts: accounts.length }, "installing launchers");
    const results = installLaunchers({ binDir, checkout, accounts });

    if (options.json) {
        out.result({ binDir, checkout, launchers: results });
        return;
    }

    const table = createBoxTable(["LAUNCHER", "ACCOUNT", "STATUS"]);

    for (const result of results) {
        table.push([result.path, result.spec.account ?? "(from TOOLS_<ALIAS>_EMBED_ACCOUNT)", statusCell(result)]);
    }

    out.println(table.toString());
    out.println(`  checkout: ${checkout}`);
}

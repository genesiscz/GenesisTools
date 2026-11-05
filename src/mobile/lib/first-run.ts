import { accessSync, constants, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { idbApprove, idbAvailable } from "@genesiscz/utils/mobile/idb";
import type { IosApp } from "@genesiscz/utils/mobile/project";
import {
    appInstalled,
    installApp,
    resetKeychain,
    setPrivacy,
    uninstallApp,
    writeAppDefault,
} from "@genesiscz/utils/mobile/simulator";
import { isObject } from "@genesiscz/utils/object";
import { boundedCommand } from "@genesiscz/utils/process/bounded-command";
import { toolDataDir } from "@genesiscz/utils/storage/root";

const log = logger.child({ component: "mobile.first-run" });

export interface PreseedReport {
    granted: string[];
    approved: string[];
    defaults: string[];
    /** Steps that failed or were skipped, each with the reason. */
    skipped: string[];
}

/**
 * On some iOS 26.5 simulators one `simctl privacy grant` wedges installd until a reboot, and it comes back after the
 * reboot. A grant that timed out leaves this marker, and later runs skip grants on that simulator.
 */
function privacyHangMarker(udid: string): string {
    return toolDataDir("mobile", "privacy-hangs", udid);
}

/**
 * Puts a fresh install into the state an unattended run needs, with no Appium: the privacy grants simctl can give,
 * the ones idb can give (camera, notifications, the URL scheme's "Open in" prompt), and the app's user defaults.
 * Each step is best-effort; what failed is in the report, never a thrown error.
 */
export async function preseedFirstRun(options: {
    firstRun: IosApp["firstRun"];
    udid: string;
    bundleId: string;
}): Promise<PreseedReport> {
    const { firstRun, udid, bundleId } = options;
    const report: PreseedReport = { granted: [], approved: [], defaults: [], skipped: [] };
    const marker = privacyHangMarker(udid);

    for (const service of firstRun.privacy) {
        if (existsSync(marker)) {
            report.skipped.push(`privacy ${service}: an earlier grant hung on this simulator (${marker})`);
            continue;
        }

        const outcome = await setPrivacy({ udid, action: "grant", service, bundleId });

        if (outcome === true) {
            report.granted.push(service);
        } else {
            if (outcome === "timeout") {
                mkdirSync(dirname(marker), { recursive: true });
                writeFileSync(marker, new Date().toISOString());
            }
            report.skipped.push(`privacy ${service}: simctl privacy failed or timed out`);
        }
    }

    const approvals = [...firstRun.idbApprove];

    if (approvals.length > 0 || firstRun.scheme) {
        if (!idbAvailable()) {
            report.skipped.push(
                `idb approve ${approvals.join(", ")}: idb is not installed (brew install idb-companion)`
            );
        } else {
            for (const service of approvals) {
                (await idbApprove({ udid, bundleId, services: [service] }))
                    ? report.approved.push(service)
                    : report.skipped.push(`idb approve ${service}: idb refused it`);
            }

            if (firstRun.scheme) {
                (await idbApprove({ udid, bundleId, services: ["url"], scheme: firstRun.scheme }))
                    ? report.approved.push(`url ${firstRun.scheme}`)
                    : report.skipped.push(`idb approve url ${firstRun.scheme}: idb refused it`);
            }
        }
    }

    for (const entry of firstRun.defaults) {
        try {
            await writeAppDefault({ udid, bundleId, key: entry.key, value: entry.value });
            report.defaults.push(entry.key);
        } catch (error) {
            // The app's data container does not exist before the first install.
            report.skipped.push(`defaults ${entry.key}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    log.info({ udid, bundleId, ...report }, "first-run preseed");
    return report;
}

/**
 * Uninstalls the app and installs the build again. iOS keeps an app's keychain items across an uninstall, so a saved login
 * survives it; `resetKeychain` empties the simulator's whole keychain as well.
 */
async function validateReplacementApp(appPath: string, bundleId: string): Promise<void> {
    if (!appPath.endsWith(".app") || !statSync(appPath).isDirectory()) {
        throw new Error("replacement must be an existing .app directory");
    }
    const result = await boundedCommand({
        command: ["/usr/bin/plutil", "-convert", "json", "-o", "-", join(appPath, "Info.plist")],
        timeoutMs: 5_000,
    });
    const info: unknown = result.status === 0 ? SafeJSON.parse(result.stdout) : null;
    if (
        !isObject(info) ||
        info.CFBundleIdentifier !== bundleId ||
        typeof info.CFBundleExecutable !== "string" ||
        basename(info.CFBundleExecutable) !== info.CFBundleExecutable
    ) {
        throw new Error("replacement .app has invalid metadata or a different bundle identifier");
    }
    const executable = join(appPath, info.CFBundleExecutable);
    if (!statSync(executable).isFile()) {
        throw new Error("replacement app executable is missing");
    }
    accessSync(executable, constants.X_OK);
}

export async function freshInstall(options: {
    udid: string;
    bundleId: string;
    appPath: string;
    resetKeychain?: boolean;
    effects?: Partial<{
        validate: typeof validateReplacementApp;
        appInstalled: typeof appInstalled;
        uninstallApp: typeof uninstallApp;
        resetKeychain: typeof resetKeychain;
        installApp: typeof installApp;
    }>;
}): Promise<void> {
    const effects = {
        validate: validateReplacementApp,
        appInstalled,
        uninstallApp,
        resetKeychain,
        installApp,
        ...options.effects,
    };
    await effects.validate(options.appPath, options.bundleId);
    if (await effects.appInstalled(options.udid, options.bundleId)) {
        await effects.uninstallApp(options.udid, options.bundleId);
    }
    if (options.resetKeychain) {
        await effects.resetKeychain(options.udid);
    }
    await effects.installApp(options.udid, options.appPath);
    log.info(options, "fresh install");
}

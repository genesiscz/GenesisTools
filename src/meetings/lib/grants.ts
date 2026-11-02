import { existsSync } from "node:fs";
import { readLivePermissions } from "@app/control/lib/permissions";
import { execToolInteractive, isInteractive } from "@genesiscz/utils/cli";
import { logger } from "@genesiscz/utils/logger";
import { genesisAppBundlePath, installedGenesisAppLauncher } from "@genesiscz/utils/macos/genesis-app";

const { log } = logger.scoped("meetings-grants");

export interface GrantOutcome {
    granted: boolean;
    /** Who captures: GenesisTools.app, or the terminal that started `tools`. */
    identity: string;
    /** What to do when it is not granted, ready to print. */
    message?: string;
}

function identityNow(): { identity: string; granted: boolean | undefined } {
    const { live, error } = readLivePermissions();

    if (!live) {
        log.warn({ error }, "screen recording: live check failed");
        return { identity: installedGenesisAppLauncher() ? "GenesisTools.app" : "this terminal", granted: undefined };
    }

    const identity = live.viaGenesisApp ? "GenesisTools.app" : (live.responsibleName ?? "this terminal");
    return { identity, granted: live.screenRecording };
}

/**
 * Screen Recording for whoever captures, by the classic route first. Without it macOS returns frames with only the
 * desktop and the menu bar, so a recording never starts without it.
 * 1. Granted: go.
 * 2. Otherwise, in a terminal: ask macOS for that identity (its own prompt and the System Settings pane), wait for it.
 * 3. Still missing, GenesisTools.app installed: its permission window takes over.
 * 4. Not installed and the terminal has no grant: say so, and propose installing the app and granting it.
 * Without a terminal (the daemon) nothing prompts: the outcome says what to run.
 */
export async function ensureScreenRecording(options: { quiet?: boolean } = {}): Promise<GrantOutcome> {
    const first = identityNow();

    if (first.granted) {
        return { granted: true, identity: first.identity };
    }

    const appInstalled = existsSync(genesisAppBundlePath());
    const installHint = appInstalled
        ? "Grant it in the window: tools macos permissions open --pane screen-recording"
        : "GenesisTools.app is not installed, and this terminal has no grant. Install the app (tools macos permissions build), then grant it: tools macos permissions open --pane screen-recording";

    if (options.quiet || !isInteractive()) {
        return {
            granted: false,
            identity: first.identity,
            message: `Screen Recording is not granted to ${first.identity}. ${installHint}`,
        };
    }

    log.info({ identity: first.identity }, "screen recording: asking macOS (classic route)");
    await execToolInteractive(["control", "permissions", "request"]);
    const second = identityNow();

    if (second.granted) {
        return { granted: true, identity: second.identity };
    }

    if (appInstalled) {
        log.info("screen recording: opening the GenesisTools.app permission window");
        await execToolInteractive(["macos", "permissions", "open", "--pane", "screen-recording"]);
        const third = identityNow();

        if (third.granted) {
            return { granted: true, identity: third.identity };
        }
    }

    return {
        granted: false,
        identity: second.identity,
        message: `Screen Recording is still not granted to ${second.identity}; macOS does not ask twice after a denial. ${installHint}`,
    };
}

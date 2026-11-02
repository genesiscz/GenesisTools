import { existsSync } from "node:fs";
import { readLivePermissions } from "@app/control/lib/permissions";
import { execToolInteractive, isInteractive } from "@genesiscz/utils/cli";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { logger } from "@genesiscz/utils/logger";
import { genesisAppBundlePath, installedGenesisAppLauncher } from "@genesiscz/utils/macos/genesis-app";

const { log } = logger.scoped("meetings-grants");

const OPEN_WINDOW = toolCommand("macos", "permissions", "ui");
/** How long the permission window gets for the user to flip the switch, and how often the grant is read meanwhile. */
const WINDOW_WAIT_MS = 180_000;
const WINDOW_POLL_MS = 2_000;

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
 * 3. Still missing, GenesisTools.app installed: its permission window opens, and the grant is read for 3 minutes.
 * 4. Not installed and the terminal has no grant: say so, and propose installing the app and granting it.
 * Without a terminal (the daemon) nothing prompts: the outcome says what to run.
 */
/** Reads the grant until it is on or the deadline passes; the window returns at once, the user takes a while. */
async function waitForGrant(timeoutMs: number): Promise<ReturnType<typeof identityNow>> {
    const deadline = Date.now() + timeoutMs;
    let now = identityNow();

    while (!now.granted && Date.now() < deadline) {
        await Bun.sleep(Math.min(WINDOW_POLL_MS, deadline - Date.now()));
        now = identityNow();
    }

    log.info({ granted: now.granted, identity: now.identity }, "screen recording: permission window wait ended");
    return now;
}

export async function ensureScreenRecording(options: { quiet?: boolean } = {}): Promise<GrantOutcome> {
    const first = identityNow();

    if (first.granted) {
        return { granted: true, identity: first.identity };
    }

    const appInstalled = existsSync(genesisAppBundlePath());
    const installHint = appInstalled
        ? `Grant it in the GenesisTools permissions window: ${OPEN_WINDOW}`
        : `GenesisTools.app is not installed, and this terminal has no grant. Install the app (${toolCommand("macos", "permissions", "build")}), then grant it: ${OPEN_WINDOW}`;

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
        await execToolInteractive(["macos", "permissions", "ui"]);
        const third = await waitForGrant(WINDOW_WAIT_MS);

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

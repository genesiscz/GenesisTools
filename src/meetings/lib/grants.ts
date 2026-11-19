import { readLivePermissions } from "@app/control/lib/permissions";
import { execToolInteractive, isInteractive } from "@genesiscz/utils/cli";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { logger } from "@genesiscz/utils/logger";
import { installedGenesisAppLauncher, isGenesisAppBundleInstalled } from "@genesiscz/utils/macos/genesis-app";

const { log } = logger.scoped("meetings-grants");

const OPEN_WINDOW = toolCommand("macos", "permissions", "ui");
/** How long the permission window gets for the user to flip the switch, and how often the grant is read meanwhile. */
const WINDOW_WAIT_MS = 180_000;
const WINDOW_POLL_MS = 2_000;

export interface GrantOutcome {
    granted: boolean;
    microphone?: boolean;
    /** Who captures: GenesisTools.app, or the terminal that started `tools`. */
    identity: string;
    /** What to do when it is not granted, ready to print. */
    message?: string;
}

function identityNow(): { identity: string; granted: boolean | undefined; microphone?: boolean; error?: string } {
    const { live, error } = readLivePermissions();

    if (!live) {
        log.warn({ error }, "screen recording: live check failed");
        return {
            identity: installedGenesisAppLauncher() ? "GenesisTools.app" : "this terminal",
            granted: undefined,
            error,
        };
    }

    const identity = live.viaGenesisApp ? "GenesisTools.app" : (live.responsibleName ?? "this terminal");
    return { identity, granted: live.screenRecording, microphone: live.microphone };
}

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

function unavailable(read: ReturnType<typeof identityNow>): GrantOutcome {
    const reason =
        read.granted === undefined
            ? `could not read the grant for Screen Recording (${read.identity}): ${read.error ?? "missing live value"}`
            : `Screen Recording is not granted to ${read.identity}.`;
    return { granted: false, identity: read.identity, message: reason };
}

/** Missing or unreadable screen access rules out frame capture. Sound-only and unattended starts return immediately. */
export async function ensureScreenRecording(
    options: { quiet?: boolean; allowSoundOnly?: boolean } = {}
): Promise<GrantOutcome> {
    const first = identityNow();

    if (first.granted) {
        return { granted: true, identity: first.identity, microphone: first.microphone };
    }

    if (options.allowSoundOnly || first.granted === undefined) {
        return unavailable(first);
    }

    const appInstalled = isGenesisAppBundleInstalled();
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
    let second = identityNow();

    if (second.granted) {
        return { granted: true, identity: second.identity, microphone: second.microphone };
    }

    if (appInstalled) {
        log.info("screen recording: opening the GenesisTools.app permission window");
        await execToolInteractive(["macos", "permissions", "ui"]);
        const third = await waitForGrant(WINDOW_WAIT_MS);
        second = third;

        if (third.granted) {
            return { granted: true, identity: third.identity, microphone: third.microphone };
        }
    }

    return {
        granted: false,
        identity: second.identity,
        message: `${unavailable(second).message} ${installHint}`,
    };
}

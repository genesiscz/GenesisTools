import { logger } from "@genesiscz/utils/logger";

const log = logger.scoped("ms-teams").log;

const APP_RUNNING_NEEDLES = [
    "MacOS/MSTeams",
    "Microsoft Teams WebView.app/Contents/MacOS/Microsoft Teams WebView",
    "com.microsoft.teams2.respawn",
];

/**
 * New Teams' Core Audio driver contains the substring MSTeams.
 * A naive `pgrep -lf MSTeams` matches that driver and aborts a quit app.
 * Observed 2026-07-23 12:48 in session 429a793a.
 */
export function isTeamsAppRunning(pgrepOutput: string): boolean {
    for (const raw of pgrepOutput.split("\n")) {
        const line = raw.trim();

        if (!line) {
            continue;
        }

        if (line.includes("MSTeamsAudioDevice.driver")) {
            continue;
        }

        if (line.includes("TeamsWidgetExtension")) {
            continue;
        }

        for (const needle of APP_RUNNING_NEEDLES) {
            if (line.includes(needle)) {
                return true;
            }
        }
    }

    return false;
}

export function pgrepTeams(): string {
    // A spawn failure (pgrep missing, fork refused) must not throw out of
    // `doctor` and the repair paths, which only ask whether Teams is up.
    try {
        const proc = Bun.spawnSync(["pgrep", "-lf", "-i", "teams"], { stdout: "pipe", stderr: "pipe" });
        const stdout = new TextDecoder().decode(proc.stdout);
        const stderr = new TextDecoder().decode(proc.stderr).trim();

        if (stderr) {
            log.debug({ stderr, exitCode: proc.exitCode }, "[ms-teams] pgrep stderr");
        }

        return stdout;
    } catch (err) {
        log.warn({ err }, "[ms-teams] pgrep could not run — treating Teams as not running");

        return "";
    }
}

export function teamsAppIsUp(): boolean {
    return isTeamsAppRunning(pgrepTeams());
}

export async function quitTeamsApp(timeoutMs = 20_000): Promise<{ alreadyDown: boolean }> {
    if (!teamsAppIsUp()) {
        return { alreadyDown: true };
    }

    const proc = Bun.spawnSync(["osascript", "-e", 'tell application "Microsoft Teams" to quit'], {
        stdout: "pipe",
        stderr: "pipe",
    });

    if (proc.exitCode !== 0) {
        const stderr = new TextDecoder().decode(proc.stderr).trim();
        const stdout = new TextDecoder().decode(proc.stdout).trim();
        throw new Error(stderr || stdout || "osascript quit failed");
    }

    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        if (!teamsAppIsUp()) {
            return { alreadyDown: false };
        }

        await Bun.sleep(1000);
    }

    throw new Error("Teams is still up after osascript quit. Quit it from the Dock, then re-run.");
}

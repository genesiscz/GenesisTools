import { logger } from "@genesiscz/utils/logger";
import { type BoundedCommandResult, boundedCommand } from "@genesiscz/utils/process/bounded-command";

/**
 * The stable code a caller matches to tell a missing Screen Recording grant from every other capture failure.
 * It leads the error message, so it survives the CLI's `ERROR: <message>` stderr line and the app's bridge.
 */
export const SCREEN_RECORDING_DENIED = "screen-recording-denied";

/** macOS returned no image because the responsible app has no Screen Recording grant. */
export class ScreenRecordingDeniedError extends Error {
    readonly code = SCREEN_RECORDING_DENIED;
    readonly permission = "screen-recording";

    constructor(readonly detail: string) {
        super(
            `[${SCREEN_RECORDING_DENIED}] Screen Recording is not allowed for this app, so macOS returned no image (${detail})`
        );
        this.name = "ScreenRecordingDeniedError";
    }
}

/** What an Escape in the selection returns: a result, not an error, so no surface reports it as a failure. */
export interface ScreenshotCancelled {
    cancelled: true;
    reason: "user";
}

export const SCREENSHOT_CANCELLED: ScreenshotCancelled = { cancelled: true, reason: "user" };

export type ScreenshotOutcome =
    | { kind: "captured" }
    | { kind: "cancelled" }
    | { kind: "denied"; detail: string }
    | { kind: "failed"; detail: string };

export type ScreenshotRunner = (options: {
    command: string[];
    output: string;
    signal?: AbortSignal;
}) => Promise<Pick<BoundedCommandResult, "status"> & Partial<Pick<BoundedCommandResult, "stderr" | "error">>>;

/** `screencapture` prints one of these when the responsible app lacks the grant (measured 2026-10-08: exit 1, "could not create image from window"). */
const DENIED_PATTERN =
    /could not create image from (window|display|rect|selection)|not authori[sz]ed|screen recording/i;

/**
 * Sorts one `screencapture -i` run. Measured: Escape exits 0 with no stderr and no file; a missing grant exits 1
 * with "could not create image from window" and no file. A non-zero exit with nothing on stderr and no file is the
 * same Escape on macOS releases that report it as exit 1.
 */
export function classifyScreenshot(input: {
    status: number | null;
    stderr?: string;
    error?: Error;
    outputExists: boolean;
}): ScreenshotOutcome {
    const stderr = input.stderr?.trim() ?? "";
    const detail = stderr || input.error?.message || `exit ${input.status}`;

    if (DENIED_PATTERN.test(stderr)) {
        return { kind: "denied", detail };
    }

    if (input.error) {
        return { kind: "failed", detail };
    }

    if (input.status === 0) {
        return input.outputExists ? { kind: "captured" } : { kind: "cancelled" };
    }

    if (!stderr && !input.outputExists && input.status !== null) {
        return { kind: "cancelled" };
    }

    return { kind: "failed", detail };
}

/** `-x` only when the user turned interface sound effects off, so a capture is heard like the system shortcut's. */
export function screencaptureCommand({ output, sound }: { output: string; sound: boolean }): string[] {
    return ["/usr/sbin/screencapture", "-i", ...(sound ? [] : ["-x"]), output];
}

/** `defaults read -g com.apple.sound.uiaudio.enabled`: "0" turns sound effects off; a missing key means on. */
export function parseUiSoundSetting(result: { status: number | null; stdout: string }): boolean {
    return !(result.status === 0 && result.stdout.trim() === "0");
}

/** System Settings → Sound → "Play user interface sound effects". Unreadable counts as on, the macOS default. */
export async function uiSoundEffectsEnabled(signal?: AbortSignal): Promise<boolean> {
    try {
        const result = await boundedCommand({
            command: ["/usr/bin/defaults", "read", "-g", "com.apple.sound.uiaudio.enabled"],
            signal,
            timeoutMs: 3_000,
        });
        const enabled = parseUiSoundSetting(result);
        logger.debug({ enabled, status: result.status }, "Interface sound effects setting read for screenshot");
        return enabled;
    } catch (error) {
        logger.debug({ error }, "Interface sound effects setting unreadable; screenshot keeps its sound");
        return true;
    }
}

const defaultRunner: ScreenshotRunner = ({ command, signal }) =>
    boundedCommand({ command, signal, timeoutMs: 120_000 });

/**
 * One interactive area selection into `output`, with the shutter sound unless the user muted interface sounds.
 * An injected runner (a test) gets no settings read unless it passes `soundEnabled` too.
 */
export async function takeInteractiveScreenshot({
    output,
    signal,
    run,
    soundEnabled,
}: {
    output: string;
    signal?: AbortSignal;
    run?: ScreenshotRunner;
    soundEnabled?: (signal?: AbortSignal) => Promise<boolean>;
}): Promise<ScreenshotOutcome> {
    const readSound = soundEnabled ?? (run ? async () => true : uiSoundEffectsEnabled);
    const command = screencaptureCommand({ output, sound: await readSound(signal) });
    const result = await (run ?? defaultRunner)({ command, output, signal });
    const outputExists = await Bun.file(output).exists();
    const outcome = classifyScreenshot({ ...result, outputExists });
    logger.debug(
        {
            command,
            status: result.status,
            error: result.error,
            stderr: result.stderr,
            outputExists,
            outcome: outcome.kind,
        },
        "Screenshot selection completed"
    );
    return outcome;
}

/** Turns a failure outcome into the error every capture door throws; the caller handles captured and cancelled. */
export function screenshotFailure(outcome: Extract<ScreenshotOutcome, { kind: "denied" | "failed" }>): Error {
    return outcome.kind === "denied"
        ? new ScreenRecordingDeniedError(outcome.detail)
        : new Error(`Screenshot capture failed: ${outcome.detail}`);
}

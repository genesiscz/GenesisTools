import { runCapturePlan } from "@app/control/lib/capture-runner";
import { controlDoctor } from "@app/control/lib/permissions";
import { logger } from "@genesiscz/utils/logger";

const { log } = logger.scoped("jev-demo");

const RECORD_SECONDS = 4;
const RECORD_ACTIVE_FPS = 2;
const RECORD_IDLE_FPS = 1;

export interface RecordOutcome {
    /** `"skipped: <reason>"` or the session directory the capture runner wrote. */
    record: string;
    ok: boolean;
}

/**
 * PR #411 printed "capture skipped" whatever the machine could do, so the flag never told anyone
 * why. This reports the real reason: the platform, the grant, or the runner's own error.
 *
 * The permission read is `CGPreflightScreenCaptureAccess` through ax-tool, which never prompts,
 * so asking is safe even when the answer is no.
 */
export async function recordReel(options: { dir: string; platform?: string }): Promise<RecordOutcome> {
    const platform = options.platform ?? process.platform;
    if (platform !== "darwin") {
        return { record: `skipped: screen capture needs macOS, this is ${platform}`, ok: false };
    }

    const doctor = controlDoctor();
    const check = doctor.checks.find((entry) => entry.id === "screen-recording");
    if (check?.status !== "granted") {
        const status = check?.status ?? "unknown";
        log.warn({ status, identity: check?.identity }, "demo --record has no screen-recording grant");
        return {
            record: `skipped: screen recording is ${status} for ${check?.identity ?? "this process"}; grant it with ${check?.openCommand ?? "tools macos permissions"}`,
            ok: false,
        };
    }

    const videoOut = `${options.dir}/reel.mov`;
    log.info({ videoOut, seconds: RECORD_SECONDS }, "demo --record starting the capture runner");
    try {
        const result = await runCapturePlan({
            capture: {
                mode: "screen",
                duration: RECORD_SECONDS,
                activeFps: RECORD_ACTIVE_FPS,
                idleFps: RECORD_IDLE_FPS,
                videoOut,
            },
            actions: [],
        });
        log.info({ sessionDir: result.sessionDir, ok: result.ok }, "demo --record finished");
        return result.captureFailed
            ? {
                  record: `skipped: the capture runner failed (${result.warnings.join("; ") || "no warning"})`,
                  ok: false,
              }
            : { record: result.sessionDir, ok: true };
    } catch (error) {
        log.warn({ error }, "demo --record failed");
        return { record: `skipped: ${error instanceof Error ? error.message : String(error)}`, ok: false };
    }
}

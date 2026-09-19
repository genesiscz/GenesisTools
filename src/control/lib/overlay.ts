import { savedJevSettings } from "@genesiscz/utils/ai/evaluation/settings";
import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import { runAx } from "./runner";

const prof = profiler.scope("control-overlay");
const { log } = logger.scoped("control-overlay");

/** A point in global screen coordinates. */
export interface ScreenPoint {
    x: number;
    y: number;
}

const MAX_SCREEN_COORDINATE = 100_000;

/**
 * Draws the cursor overlay at a real screen point after an act, whichever surface dispatched it.
 *
 * The hardware pointer never moves and nothing about the act is proven by this: the overlay is
 * feedback for a watching human, and the readback decides whether the goal happened. On unless
 * `tools jev config set cursorOverlay off`.
 */
export function emitClickOverlay(point: ScreenPoint): boolean {
    if (savedJevSettings().cursorOverlay === "off") {
        return false;
    }

    const { x, y } = point;
    if (!Number.isFinite(x) || !Number.isFinite(y) || (x === 0 && y === 0)) {
        log.debug({ x, y }, "overlay skipped: the point is unusable");
        return false;
    }

    if (Math.abs(x) > MAX_SCREEN_COORDINATE || Math.abs(y) > MAX_SCREEN_COORDINATE) {
        log.debug({ x, y }, "overlay skipped: the point is off any plausible display");
        return false;
    }

    const stop = prof.start("overlay");
    try {
        const result = runAx([
            "cursor-feedback",
            "--emit",
            "--action",
            "click",
            "--at",
            `${x},${y}`,
            "--target",
            "pixel",
        ]);
        log.info({ x, y, ok: result.ok, error: result.error }, "click overlay emitted");
        return result.ok;
    } catch (error) {
        log.debug({ error, x, y }, "cursor overlay emit failed");
        return false;
    } finally {
        stop();
    }
}

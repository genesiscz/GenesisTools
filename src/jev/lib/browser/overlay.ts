import { runAx } from "@app/control/lib/runner";
import { logger } from "@genesiscz/utils/logger";

export function emitBrowserClickOverlay(x: number, y: number): boolean {
    if (!Number.isFinite(x) || !Number.isFinite(y) || (x === 0 && y === 0)) {
        return false;
    }
    if (Math.abs(x) > 100_000 || Math.abs(y) > 100_000) {
        return false;
    }
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
        return result.ok;
    } catch (error) {
        logger.debug({ error, x, y }, "cursor overlay emit failed");
        return false;
    }
}

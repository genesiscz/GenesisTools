import { logger } from "@genesiscz/utils/logger";
import { capture } from "./ps";

const log = logger.child({ component: "process:top" });

/** Two `top` samples one second apart: the first sample's POWER column is always zero. */
const TOP_TIMEOUT_MS = 8_000;
/** How many of the most power-hungry processes one `top` sample lists; the rest read as 0. */
const TOP_ROWS = 300;

/**
 * Each pid's energy impact from `top`. A failed `top` gives an empty map, never its partial output: that
 * can end in the first sample, whose figures are all 0, and an empty map is what the report warns about.
 */
export async function readTopEnergy(run: typeof capture = capture): Promise<Map<number, number>> {
    try {
        const result = await run(
            "top",
            ["-l", "2", "-s", "1", "-stats", "pid,power", "-o", "power", "-n", String(TOP_ROWS)],
            { timeoutMs: TOP_TIMEOUT_MS }
        );

        if (result.status !== 0) {
            log.warn({ status: result.status, stderr: result.stderr.trim() }, "top failed; energy stays unknown");
            return new Map();
        }

        return parseTopPower(result.stdout);
    } catch (err) {
        log.warn({ err }, "top could not run; energy stays unknown");
        return new Map();
    }
}

/** The last `PID POWER` table of `top -l 2 -stats pid,power` (the first sample has no power figures). */
export function parseTopPower(stdout: string): Map<number, number> {
    const power = new Map<number, number>();
    const at = stdout.lastIndexOf("PID");

    if (at < 0) {
        return power;
    }

    for (const line of stdout.slice(at).split("\n").slice(1)) {
        const match = line.trim().match(/^(\d+)\s+([\d.]+)/);

        if (match) {
            power.set(Number.parseInt(match[1], 10), Number.parseFloat(match[2]));
        }
    }

    return power;
}

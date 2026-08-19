import { out } from "@genesiscz/utils/logger";
import pc from "picocolors";

/**
 * A count flag, or a clear error and exit.
 *
 * `Number.parseInt(value, 10) || fallback` silently turns `--last 0` and `--last abc`
 * into the default, so a typo runs a command the user did not ask for. Every count flag
 * in this tool goes through here instead.
 */
export function positiveIntFlag(value: string, flag: string): number {
    const parsed = Number.parseInt(value, 10);

    if (!Number.isFinite(parsed) || parsed <= 0) {
        out.error(pc.red(`${flag} must be a positive number (got "${value}").`));
        process.exit(1);
    }

    return parsed;
}

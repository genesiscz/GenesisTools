import { parseNonNegativeNumber } from "@genesiscz/utils/cli";
import { logger } from "@genesiscz/utils/logger";

/** A numeric flag in a control command: a bad value is a usage error, exit 2 (1 is reserved for a failed gate). */
export function numberFlag(value: string, flag: string, options: { max?: number } = {}): number {
    try {
        return parseNonNegativeNumber(value, flag, options);
    } catch (error) {
        logger.error(error instanceof Error ? error.message : String(error));
        process.exit(2);
    }
}

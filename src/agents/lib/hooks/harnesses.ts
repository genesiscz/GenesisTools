import { closeSync, openSync, readSync, statSync } from "node:fs";
import { SafeJSON } from "@genesiscz/utils/json";
import { HARNESS_NAMES, type HarnessName } from "./config";

/** How much of each log generation `doctor` reads from the end. */
const TAIL_BYTES = 4_000_000;

function tailOf(path: string, bytes: number): string {
    let fd: number | null = null;

    try {
        const size = statSync(path).size;
        const length = Math.min(size, bytes);
        const buffer = Buffer.alloc(length);

        fd = openSync(path, "r");
        readSync(fd, buffer, 0, length, size - length);

        return buffer.toString("utf8");
    } catch {
        // No log yet (or no rotated generation): nothing was seen there.
        return "";
    } finally {
        if (fd !== null) {
            closeSync(fd);
        }
    }
}

/**
 * When each harness last reached these hooks, read from the decision log (and its rotated
 * generation when the current one does not name a harness). The surest wiring check there is:
 * a harness whose config looks right but that never shows up here is not running the hooks.
 */
export function lastSeenPerHarness(logPath: string): Partial<Record<HarnessName, string>> {
    const seen: Partial<Record<HarnessName, string>> = {};

    for (const path of [logPath, `${logPath}.1`]) {
        if (HARNESS_NAMES.every((harness) => seen[harness])) {
            break;
        }

        for (const line of tailOf(path, TAIL_BYTES).split("\n")) {
            if (!line.includes('"harness"')) {
                continue;
            }

            let record: { at?: unknown; harness?: unknown };

            try {
                record = SafeJSON.parse(line, { strict: true }) as { at?: unknown; harness?: unknown };
            } catch {
                // The first line of a tail is usually cut in half.
                continue;
            }

            const harness = HARNESS_NAMES.find((name) => name === record.harness);

            if (harness && typeof record.at === "string" && (seen[harness] ?? "") < record.at) {
                seen[harness] = record.at;
            }
        }
    }

    return seen;
}

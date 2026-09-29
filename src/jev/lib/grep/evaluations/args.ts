import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";

function errnoCode(error: unknown): string | undefined {
    return error && typeof error === "object" && "code" in error && typeof error.code === "string"
        ? error.code
        : undefined;
}

/** A dollar or request cap for a paid run. `Infinity`, `NaN`, 0 and below stop the run before its first call. */
export function positiveCap(flag: string, raw: string | undefined, fallback: number): number {
    const value = raw === undefined ? fallback : Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`${flag} must be a finite number above 0, got "${raw}".`);
    }

    return value;
}

/** A request cap: a whole number above 0. */
export function requestCap(flag: string, raw: string | undefined, fallback: number): number {
    const value = positiveCap(flag, raw, fallback);
    if (!Number.isSafeInteger(value)) {
        throw new Error(`${flag} must be a whole number, got "${raw}".`);
    }

    return value;
}

/** A grep budget: a whole number, 0 for the exhaustive loop. `NaN` would silently mean 0. */
export function budgetArg(raw: string | undefined, fallback: number): number {
    const value = raw === undefined ? fallback : Number(raw);
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`--budget must be a whole number, 0 or above, got "${raw}".`);
    }

    return value;
}

/**
 * Write one run's report under a millisecond stamp. The file is created exclusively, so a second run in
 * the same millisecond gets a numbered name instead of replacing a paid record.
 */
export function writeResult(directory: string, suffix: string, value: unknown, now = new Date()): string {
    mkdirSync(directory, { recursive: true });
    const stamp = now.toISOString().slice(0, 23).replace(/[:T.]/g, "-");
    const body = `${SafeJSON.stringify(value, null, 2)}\n`;
    for (let attempt = 1; ; attempt++) {
        const file = join(directory, `${stamp}-${suffix}${attempt === 1 ? "" : `-${attempt}`}.json`);
        try {
            writeFileSync(file, body, { flag: "wx" });
            return file;
        } catch (error) {
            if (errnoCode(error) !== "EEXIST" || attempt >= 100) {
                throw error;
            }
        }
    }
}

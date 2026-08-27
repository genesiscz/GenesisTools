/**
 * Run a block under a chosen time zone, and actually put the old one back.
 *
 * Hand-rolling this is what poisoned the suite. The obvious shape —
 *
 *     const original = process.env.TZ;
 *     process.env.TZ = "America/Los_Angeles";
 *     try { … } finally { process.env.TZ = original; }
 *
 * — is broken on every machine where TZ is UNSET, which is the normal state on
 * macOS: `original` is `undefined`, and assigning that is a DELETE. Measured on
 * bun 1.3.13:
 *
 *   - deleting TZ does NOT return the process to the system zone; it stays in
 *     the zone that was set;
 *   - worse, after the delete the zone is LATCHED — every later assignment is
 *     ignored, so nothing downstream can put it right either.
 *
 * `process.env.TZ` is process-global, and bun runs many test files per process,
 * so a "restore" that does not restore leaves every later file in that worker
 * silently running in the wrong zone. That is a whole-suite hazard, not a local
 * one: it made `DateParser > parseDateRange handles 'since X until Y'` fail 10
 * runs out of 10 when it shared a process with the azure-devops iteration tests,
 * while passing alone.
 *
 * The cure is to name the zone to go back to instead of unsetting: an explicit
 * assignment works every time.
 */

/** The zone the process started in, read ONCE and before anything can mutate it. */
const SYSTEM_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

export function withTimeZone(timeZone: string, run: () => void): void {
    const original = process.env.TZ ?? SYSTEM_TIME_ZONE;
    process.env.TZ = timeZone;

    try {
        run();
    } finally {
        process.env.TZ = original;
    }
}

import { describe, expect, test } from "bun:test";
import { withTimeZone } from "./timezone";

/**
 * `Etc/GMT+8` / `Etc/GMT-9` rather than city names: fixed offsets with no DST, so
 * the expected minutes are exact on any machine and in any month. The signs are
 * inverted by POSIX convention, and `getTimezoneOffset()` counts minutes WEST of
 * UTC, which is why `Etc/GMT+8` is +480.
 */
describe("withTimeZone", () => {
    test("applies the zone inside the block", () => {
        withTimeZone("Etc/GMT+8", () => {
            expect(new Date().getTimezoneOffset()).toBe(480);
        });
    });

    /**
     * The whole point. The hand-rolled form restored by assigning the captured
     * `process.env.TZ` back, which is a DELETE when TZ was never set — and a delete
     * neither returns the process to the system zone nor allows any later change,
     * so one file's zone leaked into every file that followed it in that worker.
     */
    test("puts the original zone back", () => {
        const before = new Date().getTimezoneOffset();

        withTimeZone("Etc/GMT+8", () => {
            expect(new Date().getTimezoneOffset()).toBe(480);
        });

        expect(new Date().getTimezoneOffset()).toBe(before);
    });

    // The negative control for the latch: a second call has to work as well as the
    // first, which is exactly what a delete-based restore breaks.
    test("a second block still changes the zone", () => {
        const before = new Date().getTimezoneOffset();

        withTimeZone("Etc/GMT+8", () => {
            expect(new Date().getTimezoneOffset()).toBe(480);
        });

        withTimeZone("Etc/GMT-9", () => {
            expect(new Date().getTimezoneOffset()).toBe(-540);
        });

        expect(new Date().getTimezoneOffset()).toBe(before);
    });

    test("restores even when the block throws", () => {
        const before = new Date().getTimezoneOffset();

        expect(() =>
            withTimeZone("Etc/GMT+8", () => {
                throw new Error("boom");
            })
        ).toThrow("boom");

        expect(new Date().getTimezoneOffset()).toBe(before);
    });
});

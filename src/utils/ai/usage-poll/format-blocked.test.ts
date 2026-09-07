import { describe, expect, test } from "bun:test";
import { formatBlockedNotice } from "./format-blocked";

/**
 * The sentence a suppressed account shows in the TUI and on the dashboard card. Both
 * renderers call this and nothing else, so the wording is pinned here.
 *
 * The clock is rendered in the local zone through `formatClock`, so the assertions match
 * its shape rather than a fixed hour: a test that hardcoded "14:35" would be red on a
 * machine in another timezone.
 */

const NOW = Date.parse("2026-09-06T12:00:00.000Z");

describe("formatBlockedNotice", () => {
    test("names the pause, the streak and a short reason", () => {
        const notice = formatBlockedNotice(
            {
                blocked: { until: new Date(NOW + 30 * 60_000).toISOString(), failures: 3 },
                error: "Grok session token expired or invalid.",
            },
            NOW
        );

        expect(notice).toMatch(/^blocked until \d{2}:\d{2} \(3 failures\): Grok session token expired or invalid\.$/);
    });

    test("counts one failure in the singular", () => {
        const notice = formatBlockedNotice(
            { blocked: { until: new Date(NOW + 60_000).toISOString(), failures: 1 }, error: "boom" },
            NOW
        );

        expect(notice).toContain("(1 failure)");
    });

    // A usage API body runs to 200 characters and would swamp a terminal column.
    test("shortens a long reason instead of wrapping the whole card", () => {
        const notice = formatBlockedNotice(
            {
                blocked: { until: new Date(NOW + 60_000).toISOString(), failures: 2 },
                error: `Usage API 500: ${"x".repeat(300)}`,
            },
            NOW
        );

        expect(notice).toContain("…");
        expect(notice?.length).toBeLessThan(110);
    });

    test("collapses the newlines a multi-line recovery hint carries", () => {
        const notice = formatBlockedNotice(
            {
                blocked: { until: new Date(NOW + 60_000).toISOString(), failures: 2 },
                error: "Grok session token expired.\nRun the Grok CLI to refresh auth",
            },
            NOW
        );

        expect(notice).not.toContain("\n");
    });

    // The negative controls: nothing to say means the renderers fall back to the error row
    // they have always shown, so a real live failure is never dressed up as a pause.
    test("says nothing when the account is not suppressed", () => {
        expect(formatBlockedNotice({ error: "Usage API 401: unauthorized" }, NOW)).toBeNull();
    });

    test("says nothing once the block has lapsed", () => {
        expect(
            formatBlockedNotice({ blocked: { until: new Date(NOW - 1).toISOString(), failures: 4 }, error: "x" }, NOW)
        ).toBeNull();
    });

    test("says nothing when the stamp is not a date", () => {
        expect(formatBlockedNotice({ blocked: { until: "soon", failures: 4 }, error: "x" }, NOW)).toBeNull();
    });

    test("works without a reason at all", () => {
        const notice = formatBlockedNotice(
            { blocked: { until: new Date(NOW + 60_000).toISOString(), failures: 2 } },
            NOW
        );

        expect(notice).toMatch(/^blocked until \d{2}:\d{2} \(2 failures\)$/);
    });
});

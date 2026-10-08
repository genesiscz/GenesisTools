/**
 * `validateToPid` — the PR's headline safety fix, as a pure function.
 *
 * WHY IT MATTERS. Measured 2026-09-09: `hotkey --keys cmd,b --to-pid 99999`
 * printed `sent cmd,b` and exited 0 with no such process, having silently
 * fallen back to the GLOBAL event tap, so the combo landed in whatever window
 * the human had focused. The guard turns that into a refusal.
 *
 * BOTH HALVES ARE TESTED, per the house rule. A guard that rejects everything
 * would pass a rejection-only suite while breaking every real confined send, so
 * the live-pid cases are as load-bearing as the rejection cases.
 */
import { describe, expect, test } from "bun:test";
import { ocrReport, scrollTimeoutMs, typeOutcome, validateToPid } from "./interact";

describe("validateToPid", () => {
    test("undefined is fine — the flag is optional", () => {
        expect(validateToPid(undefined)).toBeNull();
    });

    describe("rejects, naming the pid and saying nothing was posted", () => {
        test("a pid with no running process", () => {
            const error = validateToPid("99999");

            expect(error).toContain("99999");
            expect(error).toContain("No event was posted");
        });

        test.each([
            ["not a number", "abc"],
            ["zero", "0"],
            ["negative", "-1"],
            ["fractional", "12.5"],
            ["empty", ""],
            ["live pid with fractional suffix", `${process.pid}.5`],
            ["live pid with text suffix", `${process.pid}oops`],
            ["outside native pid range", "2147483648"],
        ])("%s", (_label, value) => {
            expect(validateToPid(value)).toContain("No event was posted");
        });
    });

    describe("negative control — a real process still passes", () => {
        test("this process", () => {
            expect(validateToPid(String(process.pid))).toBeNull();
        });

        test("pid 1 (launchd): it exists and is not ours, which EPERM must not reject", () => {
            // A signal-zero probe of PID 1 throws EPERM for a non-root caller. Treating that
            // as "no such process" would refuse every send to another user's app.
            expect(validateToPid("1")).toBeNull();
        });
    });
});

describe("typeOutcome", () => {
    test("says typed only when the native side read the text back", () => {
        const outcome = typeOutcome({ ok: true, verified: true, length: 4, focused: 'AXTextField "Go to"' }, "Brave");

        expect(outcome.exitCode).toBe(0);
        expect(outcome.line).toContain("typed");
    });

    test("keys sent without a readback are UNVERIFIED and exit 2, never a plain success", () => {
        const outcome = typeOutcome(
            {
                ok: false,
                unverified: true,
                dispatched: true,
                verified: false,
                length: 66,
                warning: "the app reports no focused element",
                error: "UNVERIFIED: the app reports no focused element",
            },
            "Brave Browser"
        );

        expect(outcome.exitCode).toBe(2);
        expect(outcome.line).toContain("UNVERIFIED");
        expect(outcome.line).toContain("the app reports no focused element");
        expect(outcome.line).not.toContain("typed");
        // An ok envelope without a readback is no proof either.
        expect(typeOutcome({ ok: true, length: 3 }, "Brave").exitCode).toBe(2);
    });

    test("a failed type (text landed elsewhere) exits 1 with its error", () => {
        const outcome = typeOutcome(
            { ok: false, dispatched: true, verified: false, error: "the keystrokes did not land in the focused field" },
            "Brave"
        );

        expect(outcome).toEqual({ line: "the keystrokes did not land in the focused field", exitCode: 1 });
    });
});

describe("ocrReport", () => {
    // Regression test: #447 — ocr printed the text first and its only label last, which read as leaked debug output
    test("an app OCR starts with a header naming the app, window, size and block count, then the text", () => {
        const lines = ocrReport({
            ok: true,
            action: "ocr",
            app: "Terminal",
            window: "someone — zsh",
            width: 1470,
            height: 956,
            count: 2,
            blocks: [{ text: "first line" }, { text: "second line" }],
        });

        expect(lines).toEqual([
            'OCR of "Terminal" window "someone — zsh" (1470x956 px): 2 text blocks',
            "first line",
            "second line",
        ]);
    });

    test("an image OCR names the file in its header", () => {
        const lines = ocrReport({
            ok: true,
            action: "ocr",
            image: "/tmp/shot.png",
            width: 800,
            height: 600,
            count: 1,
            blocks: [{ text: "hello" }],
        });

        expect(lines[0]).toBe("OCR of /tmp/shot.png (800x600 px): 1 text block");
    });
});

describe("scrollTimeoutMs", () => {
    test("only pauses between repeats count, with finite defaults for malformed values", () => {
        expect(scrollTimeoutMs({ time: "1", repeat: "1", pause: "30" })).toBe(11_000);
        expect(scrollTimeoutMs({ time: "2", repeat: "3", pause: "0.5" })).toBe(17_000);
        expect(scrollTimeoutMs({ time: "NaN", repeat: "oops", pause: "Infinity" })).toBe(10_000);
        expect(scrollTimeoutMs({ time: "1e308", repeat: "200" })).toBe(10_000);
        expect(scrollTimeoutMs({})).toBe(10_000);
    });
});

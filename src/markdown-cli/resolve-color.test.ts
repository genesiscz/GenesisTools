import { describe, expect, test } from "bun:test";
import { resolveColor } from "./lib/color";

/**
 * Regression test: `tools markdown` defaulted `color` to on unconditionally, so
 * piping its output to a file or another program embedded raw ANSI escapes
 * (verified: `cat x.md | … | cat -v` printed `^[[91m`).
 *
 * Commander maps `--color` and `--no-color` onto the same key and defaults it to
 * true, so the value alone cannot distinguish an explicit flag from silence —
 * only the option source can.
 */
describe("resolveColor", () => {
    test("no flag: colour follows the TTY", () => {
        expect(resolveColor(true, "default", false)).toBe(false);
        expect(resolveColor(true, "default", true)).toBe(true);
        expect(resolveColor(true, undefined, false)).toBe(false);
    });

    test("--color forces colour even when piped, so `… | less -R` still works", () => {
        expect(resolveColor(true, "cli", false)).toBe(true);
    });

    test("--no-color strips even on a TTY", () => {
        expect(resolveColor(false, "cli", true)).toBe(false);
    });
});

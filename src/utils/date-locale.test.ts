import { describe, expect, test } from "bun:test";
import { toLanguageTag } from "./date-locale";

describe("toLanguageTag", () => {
    test("keeps a real POSIX locale, dropping the charset and swapping the separator", () => {
        expect(toLanguageTag("cs_CZ.UTF-8")).toBe("cs-CZ");
        expect(toLanguageTag("en_US.UTF-8")).toBe("en-US");
        expect(toLanguageTag("de")).toBe("de");
    });

    /**
     * `LANG=C.UTF-8` is what GitHub Actions and most containers set. It used to
     * reach `new Intl.DateTimeFormat("C")`, which throws `RangeError: invalid
     * language tag: C` — so every date this repo rendered under that environment
     * crashed the command that asked for it.
     */
    test("treats the POSIX locales as no preference", () => {
        expect(toLanguageTag("C.UTF-8")).toBeUndefined();
        expect(toLanguageTag("C")).toBeUndefined();
        expect(toLanguageTag("POSIX")).toBeUndefined();
    });

    test("rejects anything Intl would refuse to build a formatter from", () => {
        expect(toLanguageTag("not a locale")).toBeUndefined();
        expect(toLanguageTag("!!")).toBeUndefined();
    });

    // The negative control: whatever survives must actually format, so a tag that
    // passes the probe can never throw at the call site it was accepted for.
    test("every accepted tag builds a formatter", () => {
        for (const raw of ["cs_CZ.UTF-8", "en_US.UTF-8", "de", "pt_BR"]) {
            const tag = toLanguageTag(raw);
            expect(tag).toBeString();
            expect(() => new Intl.DateTimeFormat(tag).format(new Date(0))).not.toThrow();
        }
    });
});

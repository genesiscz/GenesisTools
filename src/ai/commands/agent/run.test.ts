import { expect, test } from "bun:test";
import { parseLimitFlag } from "./run";

/**
 * This moved here from `src/grok/lib/tui-resume.test.ts` when Grok's own `run`/`resume` became
 * the shared ones. The limit flag is now parsed once for every coding-agent tool, so the test
 * that pins it belongs beside that single parser rather than beside one tool's launcher.
 */
test("the limit flag defaults, and rejects anything that is not a positive integer", () => {
    expect(parseLimitFlag(undefined)).toBe(20);
    expect(parseLimitFlag("")).toBe(20);
    expect(parseLimitFlag("   ")).toBe(20);
    expect(parseLimitFlag("5")).toBe(5);
    expect(parseLimitFlag(undefined, 50)).toBe(50);

    // A commander option value is always a string, so "nope" and "20.5" both arrive here rather
    // than being caught by the parser. Silently reading them as the default would resume the
    // wrong count without saying so.
    expect(() => parseLimitFlag("nope")).toThrow(/positive integer/);
    expect(() => parseLimitFlag("20.5")).toThrow(/positive integer/);
    expect(() => parseLimitFlag("0")).toThrow(/positive integer/);
    expect(() => parseLimitFlag("-3")).toThrow(/positive integer/);
});

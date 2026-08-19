import { describe, expect, test } from "bun:test";
import { visibleItemBudget } from "@genesiscz/utils/prompts/clack/search-multiselect";
import { truncateVisible, visibleWidth } from "@genesiscz/utils/prompts/clack/table-select";

/**
 * Both functions exist for one reason: the prompt redraws by moving the cursor up by the
 * number of lines it printed. If a frame is taller than the screen, or any line wraps,
 * that count is wrong and every keypress paints a duplicate frame instead of replacing
 * the old one.
 */
describe("visibleItemBudget", () => {
    test("a tall terminal gets the caller's maximum", () => {
        expect(visibleItemBudget(14, 60)).toBe(14);
    });

    test("a short pane shrinks the list instead of overflowing", () => {
        expect(visibleItemBudget(14, 20)).toBe(11);
        expect(visibleItemBudget(14, 14)).toBe(5);
    });

    test("never returns less than one row, however short the pane", () => {
        for (const rows of [0, 1, 5, 9, 10]) {
            expect(visibleItemBudget(14, rows)).toBeGreaterThanOrEqual(1);
        }
    });

    test("the frame it implies still fits the screen", () => {
        // 8 chrome lines + the items + the trailing newline must stay under `rows`.
        for (let rows = 12; rows <= 60; rows++) {
            expect(visibleItemBudget(14, rows) + 8 + 1).toBeLessThanOrEqual(rows + 1);
        }
    });
});

describe("truncateVisible", () => {
    test("leaves a line that already fits", () => {
        expect(truncateVisible("hello", 10)).toBe("hello");
    });

    test("cuts to the budget and marks the cut", () => {
        const cut = truncateVisible("hello world", 8);

        expect(visibleWidth(cut)).toBe(8);
        expect(cut).toContain("…");
    });

    test("counts visible characters, not escape sequences", () => {
        const colored = `\x1b[36m${"a".repeat(40)}\x1b[39m`;

        expect(visibleWidth(truncateVisible(colored, 10))).toBe(10);
    });

    test("keeps the colors of the part it kept, and resets at the cut", () => {
        const colored = `\x1b[36mcyan\x1b[39m plain text that runs long`;
        const cut = truncateVisible(colored, 8);

        expect(cut).toContain("\x1b[36m");
        expect(cut.endsWith("\x1b[0m")).toBe(true);
    });

    test("a zero or negative budget yields nothing rather than a stray character", () => {
        expect(truncateVisible("hello", 0)).toBe("");
        expect(truncateVisible("hello", -3)).toBe("");
    });
});

import { describe, expect, test } from "bun:test";
import { buildFrameParts, type FrameSize, renderFrame, type TableSelectOptions, visibleWidth } from "./table-select";

/**
 * The redraw arithmetic, pinned.
 *
 * A prompt that redraws itself clears the number of lines it wrote. A line wider than the
 * terminal is two physical rows counted as one, and a frame taller than the screen scrolls,
 * so neither can be cleared: the old frame stays on screen and the new one stacks under it.
 * The arrow keys still work, but the copy the user is reading never changes — it reads as
 * frozen. Reported 2026-09-14 on `--resume dashboard`, whose detail zone carries a whole
 * absolute transcript path.
 */

function options(count: number, detail: string[] = []): TableSelectOptions<number> {
    return {
        message: "Resume which claude session?",
        hint: 'matching "dashboard"',
        columns: [{ label: "NAME", minWidth: 20 }, { label: "BRANCH" }, { label: "AGE", align: "right" }],
        rows: Array.from({ length: count }, (_, index) => ({
            value: index,
            badge: "●",
            cells: [`session-${index}`, "feature/next", `${index}d`],
            detail,
        })),
    };
}

function frame(opts: TableSelectOptions<number>, cursor: number, size: FrameSize): string[] {
    return renderFrame(opts, buildFrameParts(opts), "active", cursor, size).split("\n");
}

const LONG_PATH =
    "Source file: /Users/me/.claude/projects/-Users-me-Projects-shop/c40e86be-2b00-4e48-bf31-e3bb7263bd4b.jsonl";

describe("no line may wrap", () => {
    test("a detail line holding a whole transcript path is cut to the terminal width", () => {
        const lines = frame(options(4, ["Source home: /Users/me/.claude", LONG_PATH]), 0, {
            columns: 100,
            rows: 40,
        });

        expect(lines.length).toBeGreaterThan(4);
        for (const line of lines) {
            expect(visibleWidth(line)).toBeLessThanOrEqual(99);
        }
        // Cut, not dropped: the row still says which file it is about.
        expect(lines.join("\n")).toContain("Source file: /Users/me/.claude");
    });

    test("a very narrow terminal still produces a frame rather than a wrapped one", () => {
        for (const line of frame(options(4, [LONG_PATH]), 0, { columns: 20, rows: 40 })) {
            expect(visibleWidth(line)).toBeLessThanOrEqual(19);
        }
    });

    test("the submitted and cancelled frames are clamped too", () => {
        const opts = options(3, [LONG_PATH]);
        const parts = buildFrameParts(opts);

        for (const state of ["submit", "cancel"]) {
            for (const line of renderFrame(opts, parts, state, 0, { columns: 30, rows: 40 }).split("\n")) {
                expect(visibleWidth(line)).toBeLessThanOrEqual(29);
            }
        }
    });
});

describe("the frame may never be taller than the screen", () => {
    test("a long list is windowed, and says how many it is hiding", () => {
        const lines = frame(options(40), 0, { columns: 120, rows: 20 });

        expect(lines.length).toBeLessThanOrEqual(19);
        expect(lines.join("\n")).toContain("more");
    });

    test("the focused row is inside the window wherever the cursor is", () => {
        const opts = options(40);

        for (const cursor of [0, 7, 20, 39]) {
            const text = frame(opts, cursor, { columns: 120, rows: 20 }).join("\n");
            expect(text).toContain(`session-${cursor}`);
            // The pointer marks it, so a row that merely happens to be visible is not enough.
            expect(text).toMatch(new RegExp(`❯.*session-${cursor}\\b`));
        }
    });

    test("on a short screen the detail zone yields before the options do", () => {
        const detail = Array.from({ length: 8 }, (_, index) => `detail line ${index}`);
        const lines = frame(options(10, detail), 0, { columns: 120, rows: 12 });

        expect(lines.length).toBeLessThanOrEqual(11);
        // Nothing left to pick from would be worse than no detail.
        expect(lines.join("\n")).toContain("session-0");
        expect(lines.join("\n")).not.toContain("detail line 0");
    });

    test("NEGATIVE CONTROL: a frame that fits keeps every row and its detail", () => {
        const lines = frame(options(5, ["Source home: /Users/me/.claude"]), 2, { columns: 120, rows: 40 });
        const text = lines.join("\n");

        for (let index = 0; index < 5; index++) {
            expect(text).toContain(`session-${index}`);
        }
        expect(text).toContain("Source home: /Users/me/.claude");
        expect(text).not.toContain("more");
    });
});

import { afterEach, describe, expect, test } from "bun:test";
import { stripAnsi } from "@genesiscz/utils/string";
import {
    buildFrameParts,
    type FrameSize,
    renderFrame,
    type TableSelectOptions,
    terminalSize,
    visibleWidth,
} from "./table-select";

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

// One row's absolute path, wide enough that detailWidth (the max across every row) outgrows
// a normal terminal on its own.
const VERY_LONG_PATH =
    "Source file: /Users/me/.claude/projects/-Users-me-Library-Application-Support-Claude-scratch-workspaces-53e91abd-0df2-4aee-83b2-34e32296324f/c40e86be-2b00-4e48-bf31-e3bb7263bd4b.jsonl";

describe("the detail zone pads to the shared width, not past the terminal", () => {
    // Regression test: #453.2 — one session's long "Source file:" path pushed detailWidth
    // (shared across every row) past the terminal width, so every OTHER row's short or empty
    // detail lines were padded out to that same width and then truncated by the terminal-width
    // clamp, rendering as a trailing "…" on an otherwise blank line.
    test("a short detail line on a DIFFERENT row does not end in a lone ellipsis", () => {
        const opts: TableSelectOptions<number> = {
            message: "Select session to resume:",
            columns: [{ label: "NAME", minWidth: 20 }, { label: "BRANCH" }, { label: "AGE", align: "right" }],
            rows: [
                { value: 0, cells: ["session-a", "main", "1d"], detail: ["header a", VERY_LONG_PATH] },
                {
                    value: 1,
                    cells: ["session-b", "main", "2d"],
                    detail: ["header b", "continue brew and git installed"],
                },
            ],
        };

        // Focus row 1, the one with the SHORT detail lines.
        const lines = frame(opts, 1, { columns: 120, rows: 40 });
        const detailLines = lines.filter((line) => line.includes("header b") || line.includes("continue brew"));

        expect(detailLines).toHaveLength(2);
        for (const line of detailLines) {
            expect(stripAnsi(line).trimEnd().endsWith("…")).toBe(false);
        }
    });

    test("NEGATIVE CONTROL: the genuinely too-long path on the OTHER row is still cut with an ellipsis", () => {
        const opts: TableSelectOptions<number> = {
            message: "Select session to resume:",
            columns: [{ label: "NAME", minWidth: 20 }, { label: "BRANCH" }, { label: "AGE", align: "right" }],
            rows: [
                { value: 0, cells: ["session-a", "main", "1d"], detail: ["header a", VERY_LONG_PATH] },
                {
                    value: 1,
                    cells: ["session-b", "main", "2d"],
                    detail: ["header b", "continue brew and git installed"],
                },
            ],
        };

        const lines = frame(opts, 0, { columns: 120, rows: 40 });
        const pathLine = lines.find((line) => line.includes("Source file:"));

        expect(pathLine).toBeDefined();
        expect(
            stripAnsi(pathLine ?? "")
                .trimEnd()
                .endsWith("…")
        ).toBe(true);
    });
});

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

    test("a screen of six rows or fewer still gets a frame that fits it", () => {
        // The budget floor plus the minimum frame shape produced 6 lines whatever the screen
        // said, so the smallest terminals hit the very overflow this file exists to prevent.
        for (const rows of [1, 3, 6]) {
            expect(frame(options(10), 0, { columns: 120, rows }).length).toBeLessThanOrEqual(Math.max(1, rows - 1));
        }
    });

    test("the submit and cancel frames are clamped too, not only the active picker", () => {
        // Both states returned straight out of `paint()`, skipping the clamp every other frame
        // goes through. Three physical lines is already over budget on a one- or two-row screen.
        const opts = options(4);
        const parts = buildFrameParts(opts);

        for (const state of ["submit", "cancel"]) {
            for (const rows of [1, 2]) {
                const lines = renderFrame(opts, parts, state, 0, { columns: 120, rows }).split("\n");
                expect(lines.length).toBeLessThanOrEqual(Math.max(1, rows - 1));
            }
        }
    });
});

describe("a terminal that reports no size falls back instead of rendering nothing", () => {
    const realColumns = process.stdout.columns;
    const realRows = process.stdout.rows;

    afterEach(() => {
        Object.defineProperty(process.stdout, "columns", { value: realColumns, configurable: true });
        Object.defineProperty(process.stdout, "rows", { value: realRows, configurable: true });
    });

    test("a 0x0 winsize reports the defaults, not zero", () => {
        // `??` only replaces null/undefined, so a TTY reporting 0 columns kept 0 and every line
        // was truncated to a single `…`. Zero is a missing answer here, not a width.
        Object.defineProperty(process.stdout, "columns", { value: 0, configurable: true });
        Object.defineProperty(process.stdout, "rows", { value: 0, configurable: true });

        expect(terminalSize()).toEqual({ columns: 80, rows: 24 });
    });

    test("NEGATIVE CONTROL: a real size is reported unchanged", () => {
        Object.defineProperty(process.stdout, "columns", { value: 133, configurable: true });
        Object.defineProperty(process.stdout, "rows", { value: 42, configurable: true });

        expect(terminalSize()).toEqual({ columns: 133, rows: 42 });
    });
});

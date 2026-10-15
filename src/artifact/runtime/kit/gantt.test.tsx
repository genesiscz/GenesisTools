import { describe, expect, test } from "bun:test";
import {
    Gantt,
    type GanttAxis,
    type GanttBar,
    type GanttLane,
    type GanttMilestone,
    type GanttProps,
    type GanttSpan,
    ganttBarFitsLabel,
    ganttCells,
    ganttDayIndex,
    ganttDragSpan,
    ganttShiftDays,
    ganttSpanPx,
} from "./gantt";
import { mountDom } from "./test-dom";

const AXIS: GanttAxis = { start: "2026-09-17", end: "2027-03-31" };
const LANES: GanttLane[] = [
    { id: "design", label: "Design" },
    { id: "build", label: "Build" },
    { id: "test", label: "Test" },
];

function bar(id: string, lane: string, start: string, end: string, extra: Partial<GanttBar> = {}): GanttBar {
    return { id, lane, label: `Item ${id}`, start, end, ...extra };
}

const TEN_BARS: GanttBar[] = [
    bar("a", "design", "2026-09-17", "2026-09-30"),
    bar("b", "design", "2026-10-01", "2026-10-10"),
    bar("c", "design", "2026-10-05", "2026-10-20"),
    bar("d", "build", "2026-10-12", "2026-11-12"),
    bar("e", "build", "2026-11-01", "2026-11-30"),
    bar("f", "build", "2026-11-15", "2026-12-20"),
    bar("g", "build", "2026-12-01", "2027-01-15"),
    bar("h", "test", "2027-01-04", "2027-01-31"),
    bar("i", "test", "2027-02-01", "2027-02-28"),
    bar("j", "test", "2027-03-01", "2027-03-20"),
];
const MILESTONES: GanttMilestone[] = [
    { id: "m1", label: "Design review", date: "2026-10-20" },
    { id: "m2", label: "Launch", date: "2027-03-25", ghost: "2027-03-12" },
];

async function mountGantt(props: Partial<GanttProps> = {}) {
    return mountDom(<Gantt axis={AXIS} lanes={LANES} bars={TEN_BARS} {...props} />);
}

describe("Gantt day maths", () => {
    test("ganttDayIndex counts whole days, also across a clock change", () => {
        expect(ganttDayIndex("2026-10-15", "2026-09-17")).toBe(28);
        // Europe leaves summer time on 2026-10-25 and the US on 2026-11-01.
        expect(ganttDayIndex("2026-10-26", "2026-10-24")).toBe(2);
        expect(ganttDayIndex("2026-11-02", "2026-10-31")).toBe(2);
        expect(ganttDayIndex("2027-03-29", "2027-03-27")).toBe(2);
    });

    test("span pixels: 6 px a day, never under 6 px", () => {
        expect(ganttSpanPx({ start: "2026-09-18", end: "2026-09-21" }, AXIS)).toEqual({ left: 6, width: 24 });
        expect(ganttSpanPx({ start: "2026-09-18", end: "2026-09-18" }, { ...AXIS, dayWidth: 2 }).width).toBe(6);
    });

    test("shift days is the end's move against the ghost, null without one", () => {
        expect(ganttShiftDays({ end: "2026-10-24", ghost: { start: "2026-10-01", end: "2026-10-12" } })).toBe(12);
        expect(ganttShiftDays({ end: "2026-10-24" })).toBeNull();
    });

    test("an in-bar label needs max(42, chars * 7 + 10) px", () => {
        expect(ganttBarFitsLabel(24, "8.0 h")).toBe(false);
        expect(ganttBarFitsLabel(48, "8.0 h")).toBe(true);
        expect(ganttBarFitsLabel(41, "x")).toBe(false);
    });

    test("drag maths snaps, and an edge stops at minDays", () => {
        const origin: GanttSpan = { start: "2026-10-01", end: "2026-10-10" };
        expect(ganttDragSpan(origin, "end", 30, AXIS, 1, 1)).toEqual({ start: "2026-10-01", end: "2026-10-15" });
        expect(ganttDragSpan(origin, "start", -30, AXIS, 1, 1)).toEqual({ start: "2026-09-26", end: "2026-10-10" });
        expect(ganttDragSpan(origin, "move", 13, AXIS, 1, 1)).toEqual({ start: "2026-10-03", end: "2026-10-12" });
        expect(ganttDragSpan(origin, "end", -600, AXIS, 1, 3)).toEqual({ start: "2026-10-01", end: "2026-10-03" });
        expect(ganttDragSpan(origin, "start", 600, AXIS, 1, 3)).toEqual({ start: "2026-10-08", end: "2026-10-10" });
        expect(ganttDragSpan(origin, "move", 50, AXIS, 7, 1).start).toBe("2026-10-08");
    });

    test("header range text is at most 18 characters and the year shows once per year", () => {
        const cells = ganttCells(AXIS, "en-GB");

        for (const cell of cells) {
            expect(cell.range.length).toBeLessThanOrEqual(18);
            expect(cell.title).toContain(String(cell.start.slice(0, 4)));
        }

        expect(cells.filter((c) => c.year !== undefined).map((c) => c.year)).toEqual([2026, 2027]);
        expect(cells[0].range).toBe("17/09 to 30/09");
        expect(cells.length).toBe(14);
    });
});

describe("Gantt render", () => {
    test("three lanes, ten bars and two milestones give 3, 10 and 2 rows, and diamonds name their date", async () => {
        const dom = await mountGantt({ milestones: MILESTONES, locale: "en-GB" });
        const count = (kind: string): number => dom.container.querySelectorAll(`[data-gantt-row="${kind}"]`).length;

        expect([count("lane"), count("bar"), count("milestone")]).toEqual([3, 10, 2]);
        const diamonds = [...dom.container.querySelectorAll("[data-gantt-milestone]")];
        expect(diamonds.map((d) => d.getAttribute("aria-label"))).toEqual(["Design review, 20 Oct", "Launch, 25 Mar"]);
        expect(dom.container.querySelector('[role="group"]')).not.toBeNull();
        await dom.unmount();
    });

    test("a 4-day bar has no in-bar label, an 8-day bar shows 8.0 h", async () => {
        const dom = await mountDom(
            <Gantt
                axis={AXIS}
                lanes={LANES}
                bars={[
                    bar("short", "design", "2026-10-01", "2026-10-04", { barLabel: "8.0 h" }),
                    bar("long", "design", "2026-10-01", "2026-10-08", { barLabel: "8.0 h" }),
                ]}
            />
        );
        const label = (id: string): Element | null =>
            dom.container.querySelector(`[data-gantt-bar="${id}"] [data-gantt-bar-label]`);

        expect(label("short")).toBeNull();
        expect(label("long")?.textContent).toBe("8.0 h");
        await dom.unmount();
    });

    test("a ghost 12 days earlier prints +12 d in err; current hides it; baseline draws the bar at the ghost", async () => {
        const ghosted = [
            bar("late", "design", "2026-10-13", "2026-10-24", { ghost: { start: "2026-10-01", end: "2026-10-12" } }),
        ];
        const compare = await mountDom(<Gantt axis={AXIS} lanes={LANES} bars={ghosted} />);
        const shift = compare.container.querySelector("[data-gantt-shift]");

        expect(shift?.textContent).toBe("+12 d");
        expect(shift?.className).toContain("text-err");
        expect(compare.container.querySelector("[data-gantt-ghost]")?.getAttribute("aria-hidden")).toBe("true");
        expect(compare.container.querySelector('[data-gantt-bar="late"]')?.getAttribute("aria-label")).toContain(
            "12 days later than baseline"
        );
        await compare.unmount();

        const current = await mountDom(<Gantt axis={AXIS} lanes={LANES} bars={ghosted} view="current" />);
        expect(current.container.querySelector("[data-gantt-ghost]")).toBeNull();
        expect(current.container.querySelector("[data-gantt-shift]")).toBeNull();
        await current.unmount();

        const baseline = await mountDom(<Gantt axis={AXIS} lanes={LANES} bars={ghosted} view="baseline" />);
        const drawn = baseline.container.querySelector<HTMLElement>('[data-gantt-bar="late"]');
        expect(drawn?.style.left).toBe(`${ganttDayIndex("2026-10-01", AXIS.start) * 6}px`);
        await baseline.unmount();
    });

    test("today is exactly one element at (index + 0.5) * dayWidth", async () => {
        const dom = await mountGantt({ today: "2026-10-14" });
        const lines = dom.container.querySelectorAll<HTMLElement>("[data-gantt-today]");

        expect(lines.length).toBe(1);
        expect(lines[0].style.left).toBe(`${(ganttDayIndex("2026-10-14", AXIS.start) + 0.5) * 6}px`);
        expect(dom.container.querySelectorAll("[data-gantt-today-tag]").length).toBe(1);
        await dom.unmount();
    });

    test("bands and cell lines are one layer: a bar row's node count does not depend on the cell count", async () => {
        const nodes = async (end: string): Promise<number> => {
            const dom = await mountDom(<Gantt axis={{ start: AXIS.start, end }} lanes={LANES} bars={TEN_BARS} />);
            const total = dom.container.querySelector('[data-gantt-row="bar"]')?.querySelectorAll("*").length ?? -1;
            expect(dom.container.querySelectorAll("[data-gantt-bands]").length).toBe(1);
            await dom.unmount();

            return total;
        };

        expect(await nodes("2026-12-31")).toBe(await nodes("2027-12-31"));
    });

    test("colours are CSS variables only, so a colour-scheme flip retints with no script", async () => {
        const dom = await mountGantt();
        const lane = dom.container.querySelector<HTMLElement>('[data-gantt-row="lane"]');
        const first = dom.container.querySelector<HTMLElement>("[data-gantt-bar]");

        expect(lane?.getAttribute("style")).toContain("var(--series-1)");
        expect(lane?.getAttribute("style")).toContain("var(--panel)");
        expect(first?.getAttribute("style")).toContain("var(--series-1)");
        expect(dom.html()).not.toMatch(/background:\s*#/);
        await dom.unmount();
    });
});

describe("Gantt editing", () => {
    const one = [bar("x", "design", "2026-10-01", "2026-10-10")];

    async function editable(minDays = 1) {
        const changes: Array<{ id: string; next: GanttSpan; phase: string }> = [];
        const dom = await mountDom(
            <Gantt
                axis={AXIS}
                lanes={LANES}
                bars={one}
                editable
                minDays={minDays}
                onBarChange={(id, next, phase) => changes.push({ id, next, phase })}
            />
        );
        const handle = (edge: string): Element | null =>
            dom.container.querySelector(`[data-gantt-bar="x"] [data-gantt-handle="${edge}"]`);

        return { dom, changes, handle };
    }

    test("dragging the end handle 30 px commits the end 5 days later", async () => {
        const { dom, changes, handle } = await editable();
        await dom.pointer(handle("end"), "pointerdown", { clientX: 100, button: 0 });
        await dom.pointer(handle("end"), "pointermove", { clientX: 130 });
        await dom.pointer(handle("end"), "pointerup", { clientX: 130 });
        const commits = changes.filter((c) => c.phase === "commit");

        expect(commits).toEqual([{ id: "x", next: { start: "2026-10-01", end: "2026-10-15" }, phase: "commit" }]);
        expect(changes.some((c) => c.phase === "preview")).toBe(true);
        await dom.unmount();
    });

    test("Escape during a drag restores and never commits", async () => {
        const { dom, changes, handle } = await editable();
        await dom.pointer(handle("end"), "pointerdown", { clientX: 100, button: 0 });
        await dom.pointer(handle("end"), "pointermove", { clientX: 130 });
        await dom.fire(dom.window.document, new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await dom.pointer(handle("end"), "pointerup", { clientX: 130 });

        expect(changes.filter((c) => c.phase === "commit")).toEqual([]);
        expect(dom.container.querySelector<HTMLElement>('[data-gantt-bar="x"]')?.style.width).toBe("60px");
        await dom.unmount();
    });

    test("an end drag stops at minDays, and the start handle mirrors it", async () => {
        const { dom, changes, handle } = await editable(3);
        await dom.pointer(handle("end"), "pointerdown", { clientX: 500, button: 0 });
        await dom.pointer(handle("end"), "pointermove", { clientX: 100 });
        await dom.pointer(handle("end"), "pointerup", { clientX: 100 });
        await dom.pointer(handle("start"), "pointerdown", { clientX: 100, button: 0 });
        await dom.pointer(handle("start"), "pointermove", { clientX: 700 });
        await dom.pointer(handle("start"), "pointerup", { clientX: 700 });

        expect(changes.filter((c) => c.phase === "commit").map((c) => c.next)).toEqual([
            { start: "2026-10-01", end: "2026-10-03" },
            { start: "2026-10-08", end: "2026-10-10" },
        ]);
        await dom.unmount();
    });

    test("Shift plus Right moves the end one day and writes the live region", async () => {
        const { dom, changes } = await editable();
        const target = dom.container.querySelector('[data-gantt-bar="x"]');
        await dom.fire(
            target,
            new dom.window.KeyboardEvent("keydown", { key: "ArrowRight", shiftKey: true, bubbles: true })
        );

        expect(changes).toEqual([{ id: "x", next: { start: "2026-10-01", end: "2026-10-11" }, phase: "commit" }]);
        expect(dom.container.querySelector("[data-gantt-live]")?.textContent).toContain("Item x now");
        expect(dom.container.querySelector("[data-gantt-live]")?.textContent).toContain("11 days");
        await dom.unmount();
    });

    test("one tab stop: Down moves the roving tabindex to the next bar", async () => {
        const dom = await mountGantt();
        const bars = [...dom.container.querySelectorAll<HTMLElement>("[data-gantt-bar]")];

        expect(bars.filter((b) => b.tabIndex === 0).length).toBe(1);
        await dom.press(bars[0], "ArrowDown");
        expect(bars[1].tabIndex).toBe(0);
        expect(bars[0].tabIndex).toBe(-1);
        await dom.press(bars[1], "End");
        expect(bars[9].tabIndex).toBe(0);
        await dom.unmount();
    });
});

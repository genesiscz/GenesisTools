import { describe, expect, test } from "bun:test";
import type { CodeViewScrollTarget } from "@pierre/diffs";
import { createGlide, GLIDE_SETTLE_MS } from "./glide";

/**
 * A CodeView stand-in: an instant scroll lands at once, a smooth one only on `settle()` (the
 * animation frames), and the timers run on `advance()`.
 */
function fakeView(start: number, places: Record<string, number>) {
    let scrollTop = start;
    let smooth: number | null = null;
    let now = 0;
    const timers: { id: number; at: number; run: () => void }[] = [];
    const logs: string[] = [];

    function place(target: CodeViewScrollTarget): number {
        if (target.type === "position") {
            return target.position;
        }

        const key = target.type === "line" ? `${target.id}:${target.lineNumber}` : target.id;
        const top = places[key];

        if (top === undefined) {
            throw new Error(`no place for ${key}`);
        }

        return top;
    }

    const viewer = {
        getScrollTop: () => scrollTop,
        getHeight: () => 820,
        scrollTo(target: CodeViewScrollTarget) {
            if (target.behavior === "smooth") {
                smooth = place(target);
            } else {
                smooth = null;
                scrollTop = place(target);
            }
        },
        render() {},
    };
    let nextId = 1;
    const glideTo = createGlide({
        viewer,
        log: (message) => logs.push(message),
        setTimeout(run, ms) {
            const id = nextId++;
            timers.push({ id, at: now + ms, run });
            return id;
        },
        clearTimeout(id) {
            const index = timers.findIndex((timer) => timer.id === id);

            if (index >= 0) {
                timers.splice(index, 1);
            }
        },
    });

    return {
        glideTo,
        logs,
        scrollTop: () => scrollTop,
        readerScroll(top: number) {
            scrollTop = top;
            smooth = null;
        },
        settle() {
            if (smooth !== null) {
                scrollTop = smooth;
                smooth = null;
            }
        },
        advance(ms: number) {
            now += ms;
            for (const timer of timers.filter((candidate) => candidate.at <= now)) {
                timers.splice(timers.indexOf(timer), 1);
                timer.run();
            }
        },
    };
}

describe("glideTo", () => {
    // A drafts-list click is a file reveal and then a card focus: two glides back to back.
    test("a later glide to a line inside the first glide's path is not thrown back to the file's top", () => {
        const view = fakeView(36_504, { "Filters.tsx": 15_076, "Filters.tsx:36": 15_785 });

        view.glideTo({ type: "item", id: "Filters.tsx", align: "start" });
        view.glideTo({ type: "line", id: "Filters.tsx", lineNumber: 36, side: "additions", align: "center" });
        view.settle();
        view.advance(GLIDE_SETTLE_MS);

        expect(view.scrollTop()).toBe(15_785);
        expect(view.logs).toEqual([]);
    });

    test("a glide whose animation never ran lands at once after its time", () => {
        const view = fakeView(0, { "Filters.tsx:36": 2_986 });

        view.glideTo({ type: "line", id: "Filters.tsx", lineNumber: 36, side: "additions", align: "center" });
        view.advance(GLIDE_SETTLE_MS);

        expect(view.scrollTop()).toBe(2_986);
        expect(view.logs).toEqual(["glide stalled at 1756 of 2986: landed at once"]);
    });

    test("a view the reader scrolled elsewhere during the glide is left there", () => {
        const view = fakeView(0, { "Filters.tsx:36": 2_986 });

        view.glideTo({ type: "line", id: "Filters.tsx", lineNumber: 36, side: "additions", align: "center" });
        view.readerScroll(9_000);
        view.advance(GLIDE_SETTLE_MS);

        expect(view.scrollTop()).toBe(9_000);
    });
});

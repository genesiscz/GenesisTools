import { describe, expect, test } from "bun:test";
import { type AxRow, type PageRead, readPage, waitUntilReady } from "./settings-v2-ready";

const WINDOW: AxRow = { role: "AXWindow", id: "", title: "Settings", value: "", enabled: true };
const SKIP = new Set(["widget.showWidget"]);

function toggle(id: string, value: string): AxRow {
    return { role: "AXCheckBox", id, title: id, value, enabled: true };
}

function label(text: string): AxRow {
    return { role: "AXStaticText", id: "", title: "", value: text, enabled: true };
}

/** Reads that walk through `script` and then repeat its last entry, with a clock the fake sleep advances. */
function scripted(script: PageRead[]) {
    let clock = 0;
    let index = 0;
    return {
        reads: () => index,
        run: (timeoutMs: number) =>
            waitUntilReady({
                read: () => script[Math.min(index++, script.length - 1)],
                sleep: async (ms) => {
                    clock += ms;
                },
                now: () => clock,
                timeoutMs,
            }),
    };
}

describe("readPage", () => {
    test("a progress indicator, a Loading label and an unreadable-settings notice each mark a page as pending", () => {
        const spinner: AxRow = { role: "AXProgressIndicator", id: "", title: "", value: "", enabled: true };

        expect(readPage([WINDOW, spinner], SKIP).pending).toBe(true);
        expect(readPage([WINDOW, label("Loading your widget settings…")], SKIP).pending).toBe(true);
        expect(readPage([WINDOW, label("Your widget settings could not be read.")], SKIP).pending).toBe(true);
        expect(readPage([WINDOW, label("Reloading is not needed")], SKIP).pending).toBe(false);
        expect(readPage([WINDOW, toggle("clicky.sound", "1")], SKIP).pending).toBe(false);
    });

    test("the skipped switches are not listed, and a changing label does not change the outline", () => {
        const page = readPage([WINDOW, toggle("widget.showWidget", "1"), toggle("clicky.sound", "0")], SKIP);
        expect(page.switches.map((entry) => entry.key)).toEqual(["clicky.sound"]);
        expect(page.drawn).toBe(true);
        expect(readPage([WINDOW, label("3 keys")], SKIP).outline).toBe(
            readPage([WINDOW, label("4 keys")], SKIP).outline
        );
        expect(readPage([WINDOW, toggle("a", "0")], SKIP).outline).not.toBe(
            readPage([WINDOW, toggle("a", "1")], SKIP).outline
        );
        expect(readPage([WINDOW, toggle("a", "1")], SKIP).outline).not.toBe(
            readPage([WINDOW, { ...toggle("a", "1"), enabled: false }], SKIP).outline
        );
    });
});

describe("waitUntilReady", () => {
    const loading = readPage([WINDOW, label("Loading your widget settings…")], SKIP);
    const loadedWithoutSwitches = readPage([WINDOW, label("About this app")], SKIP);
    const loadedWithSwitches = readPage([WINDOW, toggle("a", "1"), toggle("b", "0")], SKIP);

    test("a page that is still loading and exposes no switches is not ready when the time runs out", async () => {
        const { run } = scripted([loading]);
        const result = await run(12_000);
        expect(result.ready).toBe(false);
        expect(result.failure).toBe("the page still showed that its data had not arrived");
    });

    test("a loaded page with no switches is ready once it has stopped moving", async () => {
        const { run, reads } = scripted([loadedWithoutSwitches]);
        const result = await run(12_000);
        expect(result.ready).toBe(true);
        expect(result.failure).toBeUndefined();
        expect(result.page.switches).toEqual([]);
        expect(reads()).toBe(3);
    });

    test("a page that loads, then shows its switches and holds still, is ready with them", async () => {
        const { run } = scripted([loading, loading, loadedWithSwitches]);
        const result = await run(12_000);
        expect(result.ready).toBe(true);
        expect(result.page.switches.map((entry) => entry.key)).toEqual(["a", "b"]);
    });

    test("a switch list that keeps changing is not ready, and the expiry says so", async () => {
        const flipping = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19].map((step) =>
            readPage([WINDOW, toggle("a", String(step % 2)), toggle("b", String(step % 3))], SKIP)
        );
        const result = await scripted(flipping).run(5_000);
        expect(result.ready).toBe(false);
        expect(result.failure).toBe("the page kept changing and never settled");
    });

    test("a window that never appears, and a read that fails, are named as such", async () => {
        const blank = readPage([], SKIP);
        expect((await scripted([blank]).run(3_000)).failure).toBe("the page never drew a window");

        const broken: PageRead = { ...blank, error: "this process lacks the Accessibility grant" };
        const result = await scripted([broken]).run(3_000);
        expect(result.ready).toBe(false);
        expect(result.failure).toBe("this process lacks the Accessibility grant");
    });

    test("a failed read in the middle starts the count again", async () => {
        const broken: PageRead = { ...readPage([], SKIP), error: "ax json failed with no output" };
        const { run, reads } = scripted([loadedWithSwitches, loadedWithSwitches, broken, loadedWithSwitches]);
        const result = await run(12_000);
        expect(result.ready).toBe(true);
        expect(reads()).toBe(6);
    });

    test("a read that finishes after the deadline does not make the page ready", async () => {
        let clock = 0;
        let reads = 0;
        const result = await waitUntilReady({
            read: () => {
                reads++;

                if (reads === 3) {
                    clock += 20_000;
                }

                return loadedWithSwitches;
            },
            sleep: async (ms) => {
                clock += ms;
            },
            now: () => clock,
            timeoutMs: 12_000,
        });

        expect(result.ready).toBe(false);
        expect(result.failure).toBe("a read of the page finished only after the deadline");
    });

    test("the wait ends at the deadline", async () => {
        const { run, reads } = scripted([loading]);
        await run(2_000);
        expect(reads()).toBe(3);
    });
});

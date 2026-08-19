import { afterEach, describe, expect, test } from "bun:test";
import { searchMultiselect } from "@genesiscz/utils/prompts/clack/search-multiselect";
import { stripAnsi } from "@genesiscz/utils/string";

/**
 * Drives the real prompt and measures what it paints.
 *
 * The bug this pins: the redraw moves the cursor up by the number of lines it wrote, so a
 * frame taller than the terminal (or a line that wraps) makes the count wrong and every
 * arrow key leaves the previous frame on screen. In a short cmux pane that showed as the
 * header repeating down the screen on ↑/↓.
 */

const restores: Array<() => void> = [];

function fakeViewport(rows: number, columns: number): void {
    for (const [key, value] of [
        ["rows", rows],
        ["columns", columns],
    ] as const) {
        const original = Object.getOwnPropertyDescriptor(process.stdout, key);
        Object.defineProperty(process.stdout, key, { value, configurable: true });
        restores.push(() => {
            if (original) {
                Object.defineProperty(process.stdout, key, original);
            }
        });
    }
}

/** Capture every frame the prompt writes, in place of the terminal. */
function captureFrames(): { frames: string[] } {
    const frames: string[] = [];
    const original = process.stdout.write.bind(process.stdout);

    process.stdout.write = ((chunk: string | Uint8Array) => {
        const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);

        // Cursor moves and line erases are the redraw; only the painted frame matters.
        if (text.includes("\n")) {
            frames.push(text);
        }

        return true;
    }) as typeof process.stdout.write;

    restores.push(() => {
        process.stdout.write = original;
    });

    return { frames };
}

function press(name: string): void {
    process.stdin.emit("keypress", "", { name, ctrl: false, meta: false, shift: false });
}

afterEach(() => {
    while (restores.length > 0) {
        restores.pop()?.();
    }
});

describe("searchMultiselect frames", () => {
    const items = Array.from({ length: 40 }, (_, i) => ({
        value: i,
        label: `session-${i} ${"x".repeat(200)}`,
        hint: "y".repeat(200),
    }));

    test("no frame is taller than the pane, and none wraps, however small the pane", async () => {
        fakeViewport(20, 100);
        const { frames } = captureFrames();

        const answer = searchMultiselect({ message: "Sessions to restore", items, maxVisible: 14 });

        for (let i = 0; i < 6; i++) {
            press("down");
        }

        press("return");
        await answer;

        expect(frames.length).toBeGreaterThan(6);

        for (const frame of frames) {
            const lines = frame.replace(/\n$/, "").split("\n");

            expect(lines.length).toBeLessThanOrEqual(19);

            for (const line of lines) {
                expect(stripAnsi(line).length).toBeLessThanOrEqual(99);
            }
        }
    });

    test("each frame paints the header exactly once — a second copy is the duplication bug", async () => {
        fakeViewport(20, 100);
        const { frames } = captureFrames();

        const answer = searchMultiselect({ message: "Sessions to restore", items, maxVisible: 14 });

        press("down");
        press("down");
        press("return");
        await answer;

        for (const frame of frames) {
            const headers = stripAnsi(frame)
                .split("\n")
                .filter((line) => line.includes("Sessions to restore"));

            expect(headers).toHaveLength(1);
        }
    });

    test("a tall pane still shows the caller's full list", async () => {
        fakeViewport(60, 200);
        const { frames } = captureFrames();

        const answer = searchMultiselect({ message: "Sessions to restore", items, maxVisible: 14 });

        press("return");
        await answer;

        const rows = stripAnsi(frames[0])
            .split("\n")
            .filter((line) => line.includes("session-"));

        expect(rows).toHaveLength(14);
    });
});

import { expect, test } from "bun:test";
import { onLoadedCodeChange } from "./loaded-modules";

test("a code change restarts only once the loaded modules read the same at two checks in a row", async () => {
    // The newest mtime per check: unchanged, a checkout writing (three different values), then quiet.
    const reads = [100, 250, 260, 270, 270, 270];
    const seen: number[] = [];
    let changed = 0;

    onLoadedCodeChange({
        root: "/work/app/",
        startedAt: 200,
        everyMs: 2,
        newest: () => {
            const value = reads[Math.min(seen.length, reads.length - 1)] ?? 0;
            seen.push(value);
            return value;
        },
        onChanged: () => {
            changed++;
        },
    });

    while (changed === 0 && seen.length < 20) {
        await Bun.sleep(2);
    }
    await Bun.sleep(10);

    // It fired at the fifth read (270 twice), and the checks stopped there.
    expect(changed).toBe(1);
    expect(seen).toEqual([100, 250, 260, 270, 270]);
});

test("code that did not change since the start never restarts, and stop ends the checks", async () => {
    let reads = 0;
    let changed = false;
    const stop = onLoadedCodeChange({
        root: "/work/app/",
        startedAt: 500,
        everyMs: 2,
        newest: () => {
            reads++;
            return 400;
        },
        onChanged: () => {
            changed = true;
        },
    });

    await Bun.sleep(15);
    stop();
    const afterStop = reads;
    await Bun.sleep(10);

    expect(changed).toBe(false);
    expect(reads).toBe(afterStop);
});

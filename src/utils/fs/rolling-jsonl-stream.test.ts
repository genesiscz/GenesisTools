import { describe, expect, it } from "bun:test";
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { createRollingJsonlStream } from "./rolling-jsonl-stream";

describe("createRollingJsonlStream", () => {
    it("swaps to the new day file on rollover and replays entries written before attach", async () => {
        const dir = mkdtempSync(join(tmpdir(), "rolling-jsonl-"));
        const day1 = join(dir, "2026-05-25.jsonl");
        const day2 = join(dir, "2026-05-26.jsonl");
        appendFileSync(day1, `${SafeJSON.stringify({ id: "d1-old" })}\n`);

        let current = day1;
        const got: string[] = [];
        const stream = createRollingJsonlStream<{ id: string }>({
            fileForNow: () => current,
            onLine: (v) => got.push(v.id),
            checkIntervalMs: 25,
        });

        // Let the tailer attach at EOF of day1 (initial file is NOT replayed).
        await Bun.sleep(120);
        appendFileSync(day1, `${SafeJSON.stringify({ id: "d1-live" })}\n`);
        await Bun.sleep(120);

        // Write day2 BEFORE rollover fires, so replay-from-start must pick it up.
        appendFileSync(day2, `${SafeJSON.stringify({ id: "d2-pre-attach" })}\n`);
        current = day2;
        await Bun.sleep(180);

        // Append after the swap — the new tailer must see it too.
        appendFileSync(day2, `${SafeJSON.stringify({ id: "d2-live" })}\n`);
        await Bun.sleep(180);
        stream.close();

        // Initial file is attached at EOF (no replay) — d1-old must not appear.
        expect(got).not.toContain("d1-old");
        expect(got).toContain("d1-live");
        // Rollover replays the new day file from byte 0.
        expect(got).toContain("d2-pre-attach");
        expect(got).toContain("d2-live");
    });
});

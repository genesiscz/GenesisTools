import { describe, expect, it } from "bun:test";
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { createRollingJsonlStream } from "./rolling-jsonl-stream";

/** Resolves once `got` holds `id`, polling every 20 ms; fails after `timeoutMs`. */
async function until(got: string[], id: string, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!got.includes(id)) {
        if (Date.now() > deadline) {
            throw new Error(`no "${id}" within ${timeoutMs} ms; got ${SafeJSON.stringify(got)}`);
        }

        await Bun.sleep(20);
    }
}

describe("createRollingJsonlStream", () => {
    it("swaps to the new day file on rollover and replays entries written before attach", async () => {
        const dir = mkdtempSync(join(tmpdir(), "rolling-jsonl-"));
        const day1 = join(dir, "2026-05-25.jsonl");
        const day2 = join(dir, "2026-05-26.jsonl");
        appendFileSync(day1, `${SafeJSON.stringify({ id: "d1-old" })}\n`);

        let today = day1;
        let tailWritten = false;
        const got: string[] = [];
        const stream = createRollingJsonlStream<{ id: string }>({
            fileForNow: () => {
                if (today !== day1 && !tailWritten) {
                    // The old file gains its last line inside the rollover check itself. A watcher event or the
                    // 300 ms poll can only run after this callback returns, so only flush() can deliver it.
                    tailWritten = true;
                    appendFileSync(day1, `${SafeJSON.stringify({ id: "d1-tail" })}\n`);
                }

                return today;
            },
            onLine: (v) => got.push(v.id),
            checkIntervalMs: 25,
        });

        try {
            // The tailer attaches at EOF of day1 when the stream is created (initial file is NOT replayed).
            // Write day2 BEFORE rollover fires, so replay-from-start must pick it up.
            appendFileSync(day2, `${SafeJSON.stringify({ id: "d2-pre-attach" })}\n`);
            today = day2;
            await until(got, "d2-pre-attach");

            // Append after the swap — the new tailer must see it too.
            appendFileSync(day2, `${SafeJSON.stringify({ id: "d2-live" })}\n`);
            await until(got, "d2-live");
        } finally {
            stream.close();
        }

        // d1-old is never replayed, the old file's tail is read before the swap, and the new file replays
        // from byte 0.
        expect(got).toEqual(["d1-tail", "d2-pre-attach", "d2-live"]);
    });
});

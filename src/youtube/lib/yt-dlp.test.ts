import { describe, expect, test } from "bun:test";
import { runDownloadWithProgress } from "./yt-dlp";

describe("runDownloadWithProgress stream draining", () => {
    test("drains both stdout and stderr so the child cannot block on a full pipe buffer", async () => {
        const start = Date.now();

        await runDownloadWithProgress(
            ["sh", "-c", 'for i in $(seq 1 5000); do echo "[download] out $i"; echo "[download] err $i" >&2; done'],
            undefined,
            () => {},
            "test"
        );

        const elapsed = Date.now() - start;
        expect(elapsed).toBeLessThan(5000);
    });
});

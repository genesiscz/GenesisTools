import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OCR_FIRST_TIMEOUT_MS, OCR_RETRY_TIMEOUT_MS, recognizeTextBoxesQueued } from "./ocr-queue";

const empty = { width: 10, height: 10, lines: [], blocks: [], text: "" };
const timeout = () => new Error("Request vision.ocr timed out after 60000ms");

describe("Vision OCR queue (round 6 item 4)", () => {
    const lockPath = () => join(mkdtempSync(join(tmpdir(), "gt-ocr-queue-")), "vision.lock");

    test("a read that times out is tried once more with a longer deadline", async () => {
        const deadlines: Array<number | undefined> = [];
        const answer = await recognizeTextBoxesQueued("/frames/1.png", {
            lockPath: lockPath(),
            reader: async (_path, options) => {
                deadlines.push(options.timeoutMs);

                if (deadlines.length === 1) {
                    throw timeout();
                }

                return empty;
            },
        });
        expect(answer).toEqual(empty);
        expect(deadlines).toEqual([OCR_FIRST_TIMEOUT_MS, OCR_RETRY_TIMEOUT_MS]);
    });

    test("two timeouts give an error that names the frame and the reason; other errors pass unchanged", async () => {
        await expect(
            recognizeTextBoxesQueued("/frames/2.png", {
                lockPath: lockPath(),
                what: "the frame at 2.00 s of demo.mp4",
                reader: async () => {
                    throw timeout();
                },
            })
        ).rejects.toThrow(/the frame at 2\.00 s of demo\.mp4 did not answer within 60 s, nor within 180 s.*busy/);
        await expect(
            recognizeTextBoxesQueued("/frames/3.png", {
                lockPath: lockPath(),
                reader: async () => {
                    throw new Error("no such file");
                },
            })
        ).rejects.toThrow("no such file");
    });

    test("reads from many callers run one at a time", async () => {
        const lock = lockPath();
        let running = 0;
        let most = 0;
        const read = async () => {
            running++;
            most = Math.max(most, running);
            await Bun.sleep(20);
            running--;
            return empty;
        };
        await Promise.all(
            Array.from({ length: 4 }, (_, index) =>
                recognizeTextBoxesQueued(`/frames/${index}.png`, { lockPath: lock, reader: read })
            )
        );
        expect(most).toBe(1);
    });
});

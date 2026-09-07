import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCaptureRuntimeLogger } from "@app/cmux/lib/capture-runtime-logger";

test("standalone runtime diagnostics rotate within two bounded generations and suppress repeated messages", () => {
    const directory = mkdtempSync(join(tmpdir(), "cmux-runtime-log-"));
    const logger = createCaptureRuntimeLogger({ directory });
    logger.debug({ state: "offline" }, "retaining cached output");
    const path = join(directory, "capture-runtime.log");
    const size = statSync(path).size;
    logger.debug({ state: "offline" }, "retaining cached output");
    expect(statSync(path).size).toBe(size);

    for (let index = 0; index < 40; index++) {
        logger.debug({ index, details: "x".repeat(60000) }, "fixture diagnostic");
    }

    expect(readdirSync(directory).sort()).toEqual(["capture-runtime.log", "capture-runtime.log.previous"]);
    expect(statSync(path).size).toBeLessThanOrEqual(1024 * 1024);
    expect(statSync(`${path}.previous`).size).toBeLessThanOrEqual(1024 * 1024);
});

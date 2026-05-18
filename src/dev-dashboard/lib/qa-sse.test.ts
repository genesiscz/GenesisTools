import { describe, expect, it } from "bun:test";
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@app/utils/json";
import { createQaStream } from "./qa-sse";

describe("createQaStream", () => {
    it("emits appended entries via the FileTailer (no replay)", async () => {
        const f = join(mkdtempSync(join(tmpdir(), "qa-sse-")), "2026-05-25.jsonl");
        appendFileSync(f, `${SafeJSON.stringify({ id: "old" })}\n`);
        const got: string[] = [];
        const stream = createQaStream(f, (e) => got.push((e as { id: string }).id));
        appendFileSync(f, `${SafeJSON.stringify({ id: "live" })}\n`);
        await Bun.sleep(500);
        stream.close();
        expect(got).toEqual(["live"]);
    });
});

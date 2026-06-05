import { describe, expect, it } from "bun:test";
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@app/utils/json";
import { assertLogFileContained, createRunLogTail } from "./daemon-run-tail";

describe("assertLogFileContained", () => {
    it("returns the resolved path for a file inside the base dir", () => {
        const base = mkdtempSync(join(tmpdir(), "tail-base-"));
        const f = join(base, "sync", "2026-06-02.jsonl");
        expect(assertLogFileContained(f, base)).toBe(f);
    });

    it("throws when the logFile escapes the base dir", () => {
        const base = mkdtempSync(join(tmpdir(), "tail-base-"));
        expect(() => assertLogFileContained(join(base, "..", "etc", "passwd"), base)).toThrow(/escapes/);
    });
});

describe("createRunLogTail", () => {
    it("emits appended entries via the FileTailer (no replay of existing content)", async () => {
        const base = mkdtempSync(join(tmpdir(), "tail-base-"));
        const f = join(base, "2026-06-02.jsonl");
        appendFileSync(f, `${SafeJSON.stringify({ type: "stdout", ts: "t0", data: "old" })}\n`);
        const got: string[] = [];
        const tail = createRunLogTail(
            f,
            (e) => {
                if (e.type === "stdout") {
                    got.push(e.data);
                }
            },
            base
        );
        appendFileSync(f, `${SafeJSON.stringify({ type: "stdout", ts: "t1", data: "live" })}\n`);
        await Bun.sleep(500);
        tail.close();
        expect(got).toEqual(["live"]);
    });
});

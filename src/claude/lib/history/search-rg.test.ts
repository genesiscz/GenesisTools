import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { rgSearchFiles } from "./search";

function jsonl(obj: Record<string, unknown>): string {
    return `${SafeJSON.stringify(obj)}\n`;
}

describe("rgSearchFiles", () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), "hist-rg-"));
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    // Regression test: stress #26 — query "session" listed every jsonl because rg -F
    // matched the sessionId JSON key, then the parser scanned thousands of false hits.
    it("does not list a jsonl whose only session hit is the sessionId key", async () => {
        const hitId = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
        const missId = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
        const hitPath = join(tmpDir, `${hitId}.jsonl`);
        const missPath = join(tmpDir, `${missId}.jsonl`);

        writeFileSync(
            hitPath,
            jsonl({
                type: "user",
                sessionId: hitId,
                timestamp: "2026-08-28T12:00:00.000Z",
                message: { role: "user", content: "resume this session now" },
            })
        );
        writeFileSync(
            missPath,
            jsonl({
                type: "user",
                sessionId: missId,
                timestamp: "2026-08-28T12:00:00.000Z",
                message: { role: "user", content: "hello world" },
            })
        );

        const files = await rgSearchFiles("session", { dir: tmpDir });

        expect(files).toEqual([hitPath]);
    });
});

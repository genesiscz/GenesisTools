import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { ripgrepBinary } from "@genesiscz/utils/ripgrep";
import { commitRgNeedle, rgSearchFiles } from "./search";

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
    // Needs a real rg. CI installs one onto PATH and the repo vendors a fallback,
    // so this only skips on a machine with neither; there the search returns []
    // for every query, which is not what this test is about.
    it.skipIf(!ripgrepBinary())("does not list a jsonl whose only session hit is the sessionId key", async () => {
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

describe("commitRgNeedle", () => {
    it("narrows a full 40-char SHA to the abbreviation transcripts actually hold", () => {
        // `git log --oneline` prints ~9 characters, so a SHA pasted from GitHub
        // matched no transcript at all and the search answered empty.
        const full = "ce39eda46c5d4b0e1f2a3b4c5d6e7f8091a2b3c4";

        expect(commitRgNeedle(full, full)).toBe("ce39eda4");
        expect(commitRgNeedle(full, undefined)).toBe("ce39eda4");
    });

    it("keeps a prefix shorter than the cap as typed", () => {
        expect(commitRgNeedle("ce39ed", undefined)).toBe("ce39ed");
    });

    it("prefers the resolved full hash, so a short prefix still yields 8 characters", () => {
        expect(commitRgNeedle("ce39ed", "ce39eda46c5d4b0e1f2a3b4c5d6e7f8091a2b3c4")).toBe("ce39eda4");
    });
});

import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeHistoryOperations } from "@genesiscz/utils/agent-sessions/readers/claude";
import type { ForwardRead, ReadForwardOptions } from "@genesiscz/utils/agent-sessions/types";
import { SafeJSON } from "@genesiscz/utils/json";
import { type TranscriptRowsDeps, transcriptRows } from "./transcript-rows";

const reader = createClaudeHistoryOperations();

function line(row: Record<string, unknown>): string {
    return `${SafeJSON.stringify(row, { strict: true })}\n`;
}

function said(uuid: string, text: string, at = "2026-03-01T10:00:00.000Z"): string {
    return line({
        type: "assistant",
        uuid,
        timestamp: at,
        message: { role: "assistant", content: [{ type: "text", text }] },
    });
}

function called(uuid: string, id: string, name: string, input: Record<string, unknown>, at: string): string {
    return line({
        type: "assistant",
        uuid,
        timestamp: at,
        message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
    });
}

/** The Claude reader over a fixture file, counting the reads and the byte each started at. */
function fixture(): { dir: string; transcript: string; reads: number[]; deps: TranscriptRowsDeps } {
    const dir = mkdtempSync(join(tmpdir(), "gt-rows-"));
    const transcript = join(dir, "s-rows.jsonl");
    const reads: number[] = [];
    const deps: TranscriptRowsDeps = {
        read: async (options: ReadForwardOptions & { kind: string; transcriptPath: string }): Promise<ForwardRead> => {
            reads.push(options.fromOffset);
            return reader.readForward(
                {
                    kind: "claude",
                    root: dir,
                    sourceHome: dir,
                    filePath: options.transcriptPath,
                    dataPaths: [options.transcriptPath],
                    metadataPaths: [],
                },
                options
            );
        },
        indexPath: () => join(dir, "index.json"),
    };

    return { dir, transcript, reads, deps };
}

describe("transcriptRows", () => {
    test("skips oversized rows and reaches later complete calls without losing a partial row", async () => {
        const { transcript, deps } = fixture();
        const huge = line({ type: "user", text: "x".repeat(17 * 1024 * 1024) });
        const call = called("a1", "toolu_after", "Bash", { command: "tools question ask" }, "2026-03-01T10:03:00.000Z");
        writeFileSync(transcript, huge + call + '{"type":"assistant"');

        const first = await transcriptRows({ transcript, deps });
        expect(first.calls.map((item) => item.id)).toEqual(["toolu_after"]);
        expect(first.offset).toBe(Buffer.byteLength(huge + call));
        expect(first.issues.some((issue) => issue.includes("Oversized row"))).toBe(true);

        appendFileSync(transcript, ',"uuid":"done","message":{"content":[]}}\n');
        const second = await transcriptRows({ transcript, deps });
        expect(second.scanned.from).toBe(first.offset);
        expect(second.offset).toBeGreaterThan(first.offset);
        expect(second.calls.map((item) => item.id)).toEqual(["toolu_after"]);
    });
    test("first asks and question calls, then only the appended bytes, and nothing for an unchanged file", async () => {
        const { transcript, reads, deps } = fixture();
        writeFileSync(
            transcript,
            line({
                type: "user",
                uuid: "u1",
                timestamp: "2026-03-01T09:59:00.000Z",
                message: { role: "user", content: "go" },
            }) +
                said("a1", "Findings.\n\n❓ DECISION 3: Keep the cache?\n- a) keep") +
                said("a2", "As asked in [❓ DECISION 4](https://example.com/find) and ❓ DECISION 3 again") +
                called(
                    "a3",
                    "toolu_post",
                    "mcp__genesis-tools__question_post",
                    { items: [] },
                    "2026-03-01T10:02:00.000Z"
                ) +
                // A script that names the command after a line break, past the per-field cap of the search text.
                called(
                    "a4",
                    "toolu_bash",
                    "Bash",
                    {
                        command: `cat > /tmp/x.json <<'EOF'\n${"x".repeat(3_000)}\nEOF\ntools question ask --json - < /tmp/x.json`,
                    },
                    "2026-03-01T10:03:00.000Z"
                ) +
                called("a5", "toolu_grep", "Grep", { pattern: "tools question" }, "2026-03-01T10:04:00.000Z")
        );

        const first = await transcriptRows({ transcript, deps });

        expect(first.asks).toEqual([{ number: 3, row: "a1" }]);
        expect(first.calls).toEqual([
            { id: "toolu_post", at: Date.parse("2026-03-01T10:02:00.000Z") },
            { id: "toolu_bash", at: Date.parse("2026-03-01T10:03:00.000Z") },
        ]);
        expect(first.scanned.from).toBe(0);

        appendFileSync(transcript, said("a6", "❓ DECISION 4: Ship it?\n- a) yes"));
        const second = await transcriptRows({ transcript, deps });

        expect(second.scanned.from).toBe(first.offset);
        expect(second.asks).toEqual([
            { number: 3, row: "a1" },
            { number: 4, row: "a6" },
        ]);

        const third = await transcriptRows({ transcript, deps });

        expect(third.scanned).toEqual({ from: second.offset, to: second.offset });
        expect(reads).toEqual([0, first.offset]);
    });

    test("a row still being written is read once it is whole", async () => {
        const { transcript, deps } = fixture();
        const whole = said("a1", "❓ DECISION 1: Port?");
        writeFileSync(transcript, whole.slice(0, 20));

        const partial = await transcriptRows({ transcript, deps });

        expect(partial.offset).toBe(0);
        expect(partial.asks).toEqual([]);

        writeFileSync(transcript, whole);
        const done = await transcriptRows({ transcript, deps });

        expect(done.asks).toEqual([{ number: 1, row: "a1" }]);
    });

    test("a replaced transcript is read again from the start", async () => {
        const { dir, transcript, reads, deps } = fixture();
        writeFileSync(transcript, said("a1", "❓ DECISION 1: Port?"));
        const first = await transcriptRows({ transcript, deps });
        const other = join(dir, "replacement.jsonl");
        writeFileSync(other, said("b1", "❓ DECISION 2: Name?") + said("b2", "more text so the file is longer"));
        renameSync(other, transcript);

        const again = await transcriptRows({ transcript, deps });

        expect(first.asks).toEqual([{ number: 1, row: "a1" }]);
        expect(again.asks).toEqual([{ number: 2, row: "b1" }]);
        expect(reads).toEqual([0, 0]);
    });
});

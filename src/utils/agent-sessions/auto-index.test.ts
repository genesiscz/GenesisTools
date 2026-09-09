import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { createNativeHistoryAdapter } from "./native-adapter";

const ID = "11111111-2222-4333-8444-555555555555";
test.each(["claude", "codex", "grok"] as const)(
    "%s history auto-builds and synchronizes changed sources without manual indexing",
    async (kind) => {
        const root = mkdtempSync(join(tmpdir(), "gt-auto-history-"));
        const directory = kind === "grok" ? join(root, encodeURIComponent("/projects/shop"), ID) : root;
        mkdirSync(directory, { recursive: true });
        const path = join(
            directory,
            kind === "grok" ? "chat_history.jsonl" : kind === "codex" ? `rollout-${ID}.jsonl` : `${ID}.jsonl`
        );
        if (kind === "grok") {
            writeFileSync(
                join(directory, "summary.json"),
                SafeJSON.stringify({ info: { id: ID, cwd: "/projects/shop" }, generated_title: "Fixture" })
            );
        }
        function writeTranscript(text: string): string {
            const rows =
                kind === "codex"
                    ? [
                          { type: "session_meta", payload: { id: ID, cwd: "/projects/shop" } },
                          {
                              type: "response_item",
                              payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
                          },
                      ]
                    : [
                          {
                              type: "assistant",
                              sessionId: ID,
                              cwd: "/projects/shop",
                              ...(kind === "claude"
                                  ? { message: { content: [{ type: "text", text }] } }
                                  : { content: [{ type: "text", text }] }),
                          },
                      ];
            const bytes = `${rows.map((row) => SafeJSON.stringify(row)).join("\n")}\n`;
            writeFileSync(path, bytes);
            return bytes;
        }
        const db = new Database(":memory:");
        try {
            const adapter = createNativeHistoryAdapter({ kind, roots: [root], database: db });
            const first = writeTranscript("first answer");
            expect(await adapter.search({ query: "first answer" })).toHaveLength(1);
            expect(readFileSync(path, "utf8")).toBe(first);
            const second = writeTranscript("changed answer");
            expect(await adapter.search({ query: "changed answer" })).toHaveLength(1);
            expect(await adapter.search({ query: "first answer" })).toHaveLength(0);
            expect(await adapter.list({})).toHaveLength(1);
            expect(readFileSync(path, "utf8")).toBe(second);
        } finally {
            db.close();
        }
    }
);

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import type { ResolvedTranscript } from "./resolve";
import { followTranscript } from "./tail";
import type { TranscriptEnvelope } from "./types";

describe("followTranscript", () => {
    test("emits a snapshot then a second envelope after the JSONL grows", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-tail-"));
        mkdirSync(dir, { recursive: true });
        const file = join(dir, "updates.jsonl");
        writeFileSync(
            file,
            `${SafeJSON.stringify({
                timestamp: 1_700_000_000,
                params: {
                    update: {
                        sessionUpdate: "agent_message_chunk",
                        content: { type: "text", text: "one" },
                    },
                },
            })}\n`
        );
        const resolved: ResolvedTranscript = {
            provider: "grok",
            source: "native",
            sessionId: "tail-sess",
            filePath: file,
        };
        const envelopes: TranscriptEnvelope[] = [];
        const ac = new AbortController();
        const done = followTranscript(resolved, {
            signal: ac.signal,
            onEnvelope: (envelope) => {
                envelopes.push(envelope);
            },
        });

        const started = Date.now();
        while (envelopes.length < 1 && Date.now() - started < 2000) {
            await Bun.sleep(50);
        }
        expect(envelopes[0]?.turns[0]?.text).toBe("one");

        writeFileSync(
            file,
            `${readFileSync(file, "utf8")}${SafeJSON.stringify({
                timestamp: 1_700_000_010,
                params: {
                    update: {
                        sessionUpdate: "agent_message_chunk",
                        content: { type: "text", text: " two" },
                    },
                },
            })}\n${SafeJSON.stringify({
                timestamp: 1_700_000_011,
                params: { update: { sessionUpdate: "turn_completed" } },
            })}\n`
        );

        while (envelopes.length < 2 && Date.now() - started < 4000) {
            await Bun.sleep(50);
        }
        ac.abort();
        await done;
        expect(envelopes.length).toBeGreaterThanOrEqual(2);
        expect(envelopes.at(-1)?.turns[0]?.text).toContain("two");
    });
});

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
    test("a rewrite back to the same size, changing only a tool result, is not deduplicated", async () => {
        // PR #341 review t7. The dedupe key fingerprinted role/at/text only. A
        // turn whose text is empty because all its content is TOOL output then
        // produced a byte-identical key no matter what the tool did, so the
        // consumer kept showing the stale result.
        //
        // Reached through truncate-then-regrow, which is the path that can
        // actually deliver two emits at the same byteSize: the watcher resets
        // its offset on a shrink, so the regrown file is re-read in full.
        const dir = mkdtempSync(join(tmpdir(), "gt-tail-tool-"));
        mkdirSync(dir, { recursive: true });
        const file = join(dir, "updates.jsonl");

        // "ok" and "no" are the same length, so byteSize, turn count and
        // nextOffset are all identical across the rewrite and the content
        // fingerprint is the only thing left to tell the two apart.
        const log = (result: string): string =>
            `${SafeJSON.stringify({
                timestamp: 1_700_000_000,
                params: {
                    update: {
                        sessionUpdate: "tool_call",
                        toolCallId: "t1",
                        title: "Bash",
                        rawInput: { command: "ls" },
                    },
                },
            })}\n${SafeJSON.stringify({
                timestamp: 1_700_000_001,
                params: {
                    update: {
                        sessionUpdate: "tool_call_update",
                        toolCallId: "t1",
                        content: { type: "text", text: result },
                    },
                },
            })}\n${SafeJSON.stringify({
                timestamp: 1_700_000_002,
                params: { update: { sessionUpdate: "turn_completed" } },
            })}\n`;

        const before = log("ok");
        const after = log("no");
        // The premise of the whole test: identical length, and a turn whose
        // only difference lives in `tools`.
        expect(after.length).toBe(before.length);

        writeFileSync(file, before);

        const resolved: ResolvedTranscript = {
            provider: "grok",
            source: "native",
            sessionId: "tail-tool",
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

        const waitFor = async (predicate: () => boolean): Promise<void> => {
            const started = Date.now();
            while (!predicate() && Date.now() - started < 3000) {
                await Bun.sleep(50);
            }
        };

        // try/finally, because an assertion below throwing would otherwise leave
        // followTranscript holding its FileTailer and 300ms interval for the rest
        // of the suite — it only resolves after abort (PR #341 review t10).
        try {
            await waitFor(() => envelopes.length >= 1);
            expect(envelopes[0]?.turns[0]?.text).toBe("");
            expect(envelopes[0]?.turns[0]?.tools[0]?.result).toBe("ok");

            // Shrink first, so the watcher resets its offset, then regrow to the
            // identical size with different tool output. The empty state emits
            // nothing of its own, so this waits out a poll interval rather than
            // watching for an envelope that never arrives.
            writeFileSync(file, "");
            await Bun.sleep(500);
            writeFileSync(file, after);

            await waitFor(() => envelopes.some((e) => e.turns[0]?.tools[0]?.result === "no"));

            const final = envelopes.at(-1);
            expect(final?.byteSize).toBe(envelopes[0]?.byteSize);
            expect(final?.turns[0]?.tools[0]?.result).toBe("no");
        } finally {
            ac.abort();
            await done;
        }
    });

    test("a control character moving between two tool fields is not a duplicate", async () => {
        // PR #341 review t8. The fingerprint used to join tool fields with an
        // unescaped \u0003, which is not injective: inputPreview="a\u0003b" with
        // result="c" and inputPreview="a" with result="b\u0003c" flatten to the
        // same string. Those characters are legal in JSONL when escaped, and
        // moving one between equal-length fields keeps byteSize, turn count and
        // offset identical — so the changed envelope was discarded.
        const dir = mkdtempSync(join(tmpdir(), "gt-tail-delim-"));
        mkdirSync(dir, { recursive: true });
        const file = join(dir, "updates.jsonl");

        const log = (input: string, result: string): string =>
            `${SafeJSON.stringify({
                timestamp: 1_700_000_000,
                params: {
                    update: {
                        sessionUpdate: "tool_call",
                        toolCallId: "t1",
                        title: "Bash",
                        rawInput: { command: input },
                    },
                },
            })}\n${SafeJSON.stringify({
                timestamp: 1_700_000_001,
                params: {
                    update: {
                        sessionUpdate: "tool_call_update",
                        toolCallId: "t1",
                        content: { type: "text", text: result },
                    },
                },
            })}\n${SafeJSON.stringify({
                timestamp: 1_700_000_002,
                params: { update: { sessionUpdate: "turn_completed" } },
            })}\n`;

        const before = log("a\u0003b", "c");
        const after = log("a", "b\u0003c");
        // The collision's precondition: the same bytes on disk, the same
        // delimiter-joined flattening, a different envelope.
        expect(after.length).toBe(before.length);

        writeFileSync(file, before);

        const resolved: ResolvedTranscript = {
            provider: "grok",
            source: "native",
            sessionId: "tail-delim",
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

        const waitFor = async (predicate: () => boolean): Promise<void> => {
            const started = Date.now();
            while (!predicate() && Date.now() - started < 3000) {
                await Bun.sleep(50);
            }
        };

        try {
            await waitFor(() => envelopes.length >= 1);
            expect(envelopes[0]?.turns[0]?.tools[0]?.result).toBe("c");

            writeFileSync(file, "");
            await Bun.sleep(500);
            writeFileSync(file, after);

            await waitFor(() => envelopes.some((e) => e.turns[0]?.tools[0]?.result === "b\u0003c"));

            const final = envelopes.at(-1);
            expect(final?.byteSize).toBe(envelopes[0]?.byteSize);
            expect(final?.turns[0]?.tools[0]?.result).toBe("b\u0003c");
            expect(final?.turns[0]?.tools[0]?.inputPreview).toBe("a");
        } finally {
            ac.abort();
            await done;
        }
    });
});

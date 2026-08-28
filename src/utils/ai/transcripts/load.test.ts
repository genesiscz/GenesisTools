import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { transcriptEnvelope } from "./load";
import type { ResolvedTranscript } from "./resolve";

function fixtureRoot(): string {
    return mkdtempSync(join(tmpdir(), "gt-load-"));
}

describe("transcriptEnvelope", () => {
    test("loads grok native ACP updates into assistant turns", async () => {
        const root = fixtureRoot();
        const file = join(root, "updates.jsonl");
        writeFileSync(
            file,
            [
                SafeJSON.stringify({
                    timestamp: 1_700_000_000,
                    params: {
                        update: {
                            sessionUpdate: "agent_message_chunk",
                            content: { type: "text", text: "listing" },
                        },
                    },
                }),
                SafeJSON.stringify({
                    timestamp: 1_700_000_001,
                    params: { update: { sessionUpdate: "turn_completed" } },
                }),
            ].join("\n")
        );
        const resolved: ResolvedTranscript = {
            provider: "grok",
            source: "native",
            sessionId: "sess",
            filePath: file,
        };
        const envelope = await transcriptEnvelope(resolved);
        expect(envelope.provider).toBe("grok");
        expect(envelope.turns[0]?.text).toBe("listing");
        expect(envelope.filePath).toBe(file);
        expect(envelope.byteSize).toBeGreaterThan(0);
    });

    test("skips malformed JSONL in the loader, not only in converters", async () => {
        const root = fixtureRoot();
        const file = join(root, "updates.jsonl");
        writeFileSync(
            file,
            [
                "not json",
                '{"params":',
                SafeJSON.stringify({
                    timestamp: 1_700_000_000,
                    params: {
                        update: {
                            sessionUpdate: "agent_message_chunk",
                            content: { type: "text", text: "ok" },
                        },
                    },
                }),
                SafeJSON.stringify({
                    timestamp: 1_700_000_001,
                    params: { update: { sessionUpdate: "turn_completed" } },
                }),
            ].join("\n")
        );
        const envelope = await transcriptEnvelope({
            provider: "grok",
            source: "native",
            sessionId: "sess",
            filePath: file,
        });
        expect(envelope.turns[0]?.text).toBe("ok");
    });

    test("loads codex GT events and native rollout lines", async () => {
        const root = fixtureRoot();
        mkdirSync(root, { recursive: true });
        const gtFile = join(root, "gt.jsonl");
        writeFileSync(
            gtFile,
            `${SafeJSON.stringify({
                seq: 1,
                ts: "2026-08-27T20:00:00.000Z",
                source: "app-server",
                method: "item/agentMessage/delta",
                params: { delta: "from gt" },
            })}\n`
        );
        const gt = await transcriptEnvelope({
            provider: "codex",
            source: "worker",
            sessionId: "gt",
            filePath: gtFile,
        });
        expect(gt.turns[0]?.text).toContain("from gt");

        const nativeFile = join(root, "native.jsonl");
        writeFileSync(
            nativeFile,
            `${SafeJSON.stringify({
                type: "event_msg",
                timestamp: "2026-08-27T20:00:00.000Z",
                payload: { type: "agent_message", message: "from native" },
            })}\n`
        );
        const native = await transcriptEnvelope({
            provider: "codex",
            source: "native",
            sessionId: "nat",
            filePath: nativeFile,
        });
        expect(native.turns[0]?.text).toBe("from native");
    });
});

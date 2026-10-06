import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    deliverMemoTranscript,
    embeddedTranscriptResult,
    type TranscriptDeliveryDeps,
    transcribeAll,
    transcribeOne,
} from "@app/macos/commands/voice-memos/index";
import { SafeJSON } from "@genesiscz/utils/json";
import type { VoiceMemo } from "@genesiscz/utils/macos/voice-memos";

const memo = (id: number, hasTranscript: boolean): VoiceMemo => ({
    id,
    title: `Memo ${id}`,
    date: new Date("2026-01-01T00:00:00.000Z"),
    duration: 12,
    path: `/fixtures/memo-${id}.m4a`,
    uuid: `memo-${id}`,
    hasTranscript,
});

const embedded = {
    text: "First phrase. Second phrase.",
    segments: [
        { text: "First phrase.", startTime: 0, endTime: 1.5 },
        { text: "Second phrase.", startTime: 1.5 },
    ],
};

const aiResult = {
    text: "Generated phrase.",
    segments: [{ text: "Generated phrase.", start: 0, end: 2 }],
};

describe("voice memo transcript delivery", () => {
    it("formats and writes an embedded transcript without creating an AI transcriber", async () => {
        const dir = mkdtempSync(join(tmpdir(), "voice-memo-delivery-"));
        const output = join(dir, "memo.json");
        let aiCreates = 0;

        await transcribeOne(
            { id: 1, format: "json", output },
            {
                resolveMemo: () => memo(1, true),
                extractTranscript: () => embedded,
                createTranscriber: async () => {
                    aiCreates++;
                    throw new Error("AI should not be created for an embedded transcript");
                },
                deliver: deliverMemoTranscript,
            }
        );

        const written = SafeJSON.parse(readFileSync(output, "utf8")) as { text: string; segments: unknown[] };
        expect(written.text).toBe(embedded.text);
        expect(written.segments).toHaveLength(2);
        expect(aiCreates).toBe(0);
    });

    it("uses the same SRT, VTT, and clipboard delivery contract for embedded segments", async () => {
        const result = embeddedTranscriptResult(embedded);
        const copied: string[] = [];
        const written = new Map<string, string>();
        const deps: TranscriptDeliveryDeps = {
            copy: async (value) => {
                copied.push(value);
            },
            write: async (filePath, value) => {
                written.set(filePath, value);
            },
            print: () => {},
        };

        await deliverMemoTranscript({ result, format: "srt", output: "/fixtures/memo.srt" }, deps);
        await deliverMemoTranscript({ result, format: "vtt", clipboard: true }, deps);

        expect(written.get("/fixtures/memo.srt")).toContain("00:00:00,000 --> 00:00:01,500");
        expect(copied[0]).toStartWith("WEBVTT\n\n");
        expect(copied[0]).toContain("00:00:01.500 --> 00:00:03.500");
    });

    it("delivers AI output through the same formatter and disposes the transcriber", async () => {
        let disposed = 0;
        const delivered: string[] = [];

        await transcribeOne(
            { id: 2, format: "json" },
            {
                resolveMemo: () => memo(2, false),
                extractTranscript: () => null,
                createTranscriber: async () => ({
                    transcribe: async () => aiResult,
                    dispose: () => {
                        disposed++;
                    },
                }),
                deliver: async (args) => {
                    delivered.push(args.result.text);
                    return { formatted: args.result.text, outputPath: null };
                },
            }
        );

        expect(delivered).toEqual([aiResult.text]);
        expect(disposed).toBe(1);
    });
});

describe("voice memo bulk transcription", () => {
    it("uses embedded text for one memo and AI fallback for the missing transcript", async () => {
        const memos = [memo(1, true), memo(2, false)];
        let aiCreates = 0;
        const delivered: number[] = [];

        await transcribeAll(
            { provider: "local-hf", format: "text" },
            {
                listMemos: () => memos,
                exists: () => true,
                transcribe: async (opts) =>
                    transcribeOne(opts, {
                        resolveMemo: (id) => memos.find((candidate) => candidate.id === id)!,
                        extractTranscript: (filePath) => (filePath === memos[0].path ? embedded : null),
                        createTranscriber: async () => {
                            aiCreates++;
                            return { transcribe: async () => aiResult, dispose: () => {} };
                        },
                        deliver: async (args) => {
                            delivered.push(args.result.text === embedded.text ? 1 : 2);
                            return { formatted: args.result.text, outputPath: null };
                        },
                    }),
            }
        );

        expect(aiCreates).toBe(1);
        expect(delivered).toEqual([1, 2]);
    });

    it("force bypasses embedded transcripts and invokes AI for every existing memo", async () => {
        const memos = [memo(1, true), memo(2, false), memo(3, false)];
        let aiCreates = 0;

        await transcribeAll(
            { force: true, provider: "local-hf", format: "text" },
            {
                listMemos: () => memos,
                exists: (filePath) => filePath !== memos[2].path,
                transcribe: async (opts) =>
                    transcribeOne(opts, {
                        resolveMemo: (id) => memos.find((candidate) => candidate.id === id)!,
                        extractTranscript: () => embedded,
                        createTranscriber: async () => {
                            aiCreates++;
                            return { transcribe: async () => aiResult, dispose: () => {} };
                        },
                        deliver: async (args) => ({ formatted: args.result.text, outputPath: null }),
                    }),
            }
        );

        expect(aiCreates).toBe(2);
    });

    it("rejects ambiguous clipboard output before processing and reports individual failures after continuing", async () => {
        let calls = 0;
        await expect(
            transcribeAll(
                { clipboard: true },
                {
                    listMemos: () => [memo(1, true)],
                    exists: () => true,
                    transcribe: async () => {
                        calls++;
                        throw new Error("transcribe must not run for an invalid bulk destination");
                    },
                }
            )
        ).rejects.toThrow("--clipboard cannot be combined with --all");
        expect(calls).toBe(0);

        await expect(
            transcribeAll(
                {},
                {
                    listMemos: () => [memo(1, false), memo(2, false), memo(3, false)],
                    exists: (filePath) => filePath !== "/fixtures/memo-3.m4a",
                    transcribe: async ({ id }) => {
                        calls++;
                        if (id === 1) {
                            throw new Error("fixture failure");
                        }
                    },
                }
            )
        ).rejects.toThrow("1 voice memo transcription failed");
        expect(calls).toBe(2);
    });
});

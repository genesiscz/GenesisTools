import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeRgbaToPng } from "@genesiscz/utils/image/raster";
import { SafeJSON } from "@genesiscz/utils/json";
import { createCanvas } from "@napi-rs/canvas";
import { recordAnswer } from "./record";
import type { QaEntry } from "./types";

describe("recordAnswer", () => {
    it("appends a resolved entry and returns its id", async () => {
        const logBase = mkdtempSync(join(tmpdir(), "qa-rec-"));
        const res = await recordAnswer(
            { question: "why bun?", answer: "fast + native sqlite", tag: "question", source: "cli" },
            {
                logBase,
                env: { CLAUDE_CODE_SESSION_ID: "sess-9", CLAUDECODE: "1" },
                config: { sinks: { obsidian: false, sound: false, notify: false } },
            }
        );
        expect(res.id).toMatch(/.+/);
        const file = join(logBase, readdirSync(logBase)[0]);
        const row = SafeJSON.parse(readFileSync(file, "utf8").trim()) as {
            question: string;
            sessionId: string;
            project: string;
            agent: string;
        };
        expect(row.question).toBe("why bun?");
        expect(row.sessionId).toBe("sess-9");
        expect(row.project.length).toBeGreaterThan(0);
        expect(row.agent).toBe("claude-code");
    });

    it("rejects empty question/answer", async () => {
        const logBase = mkdtempSync(join(tmpdir(), "qa-rec-"));
        await expect(
            recordAnswer(
                { question: " ", answer: "x", tag: "question", source: "cli" },
                { logBase, config: { sinks: { obsidian: false, sound: false, notify: false } } }
            )
        ).rejects.toThrow(/question/i);
    });
});

describe("answer image attachments", () => {
    function setup() {
        const root = mkdtempSync(join(tmpdir(), "qa-images-"));
        const path = join(root, "source.dat");
        const bytes = encodeRgbaToPng(new Uint8ClampedArray([240, 40, 30, 255, 20, 100, 60, 255]), 2, 1);
        writeFileSync(path, bytes);
        return { root, path, bytes, logBase: join(root, "log"), attachmentsRoot: join(root, "durable") };
    }

    const config = { sinks: { obsidian: false, sound: false, notify: false } } as const;

    it("copies actual image bytes durably and preserves comparison metadata", async () => {
        const fixture = setup();
        const receipt = await recordAnswer(
            {
                question: "Does the control look correct?",
                answer: "Compare these states.",
                tag: "question",
                source: "mcp",
                attachments: [
                    {
                        type: "image",
                        path: fixture.path,
                        label: "Before",
                        comparison: { group: "control", role: "before" },
                    },
                    {
                        type: "image",
                        path: fixture.path,
                        label: "After",
                        comparison: { group: "control", role: "after" },
                    },
                ],
            },
            { ...fixture, config }
        );
        renameSync(fixture.path, join(fixture.root, "moved-original"));
        const entry: QaEntry = SafeJSON.parse(
            readFileSync(join(fixture.logBase, readdirSync(fixture.logBase)[0]), "utf8")
        );
        expect(entry.attachments).toHaveLength(2);
        expect(receipt.attachments).toEqual(entry.attachments);
        const image = entry.attachments![0];
        expect(image.mimeType).toBe("image/png");
        expect(image.path.endsWith(".png")).toBe(true);
        expect(image.name).toBe("source.dat");
        expect(image.width).toBe(2);
        expect(image.height).toBe(1);
        expect(image.comparison).toEqual({ group: "control", role: "before" });
        expect(Buffer.compare(readFileSync(image.path), fixture.bytes)).toBe(0);
        expect(entry.attachments![1].id).not.toBe(image.id);
    });

    it("rejects a missing source without recording an answer", async () => {
        const fixture = setup();
        await expect(
            recordAnswer(
                {
                    question: "q",
                    answer: "a",
                    tag: "question",
                    source: "cli",
                    attachments: [{ type: "image", path: join(fixture.root, "missing.png") }],
                },
                { ...fixture, config }
            )
        ).rejects.toThrow();
        expect(readdirSync(fixture.root)).toEqual(["source.dat"]);
    });

    it("rejects a disguised non-image and a truncated image", async () => {
        for (const bytes of [Buffer.from("not an image"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])]) {
            const fixture = setup();
            writeFileSync(fixture.path, bytes);
            await expect(
                recordAnswer(
                    {
                        question: "q",
                        answer: "a",
                        tag: "question",
                        source: "cli",
                        attachments: [{ type: "image", path: fixture.path }],
                    },
                    { ...fixture, config }
                )
            ).rejects.toThrow();
            expect(readdirSync(fixture.root)).toEqual(["source.dat"]);
        }
    });

    it("rejects duplicated roles before importing any bytes", async () => {
        const fixture = setup();
        const attachment = {
            type: "image",
            path: fixture.path,
            comparison: { group: "pair", role: "before" },
        } as const;
        await expect(
            recordAnswer(
                {
                    question: "q",
                    answer: "a",
                    tag: "question",
                    source: "cli",
                    attachments: [attachment, attachment],
                },
                { ...fixture, config }
            )
        ).rejects.toThrow("Duplicate before");
        expect(readdirSync(fixture.root)).toEqual(["source.dat"]);
    });

    it("validates the whole batch before publishing files or the entry", async () => {
        const fixture = setup();
        const bad = join(fixture.root, "bad.png");
        writeFileSync(bad, "not png");
        await expect(
            recordAnswer(
                {
                    question: "q",
                    answer: "a",
                    tag: "question",
                    source: "cli",
                    attachments: [
                        { type: "image", path: fixture.path },
                        { type: "image", path: bad },
                    ],
                },
                { ...fixture, config }
            )
        ).rejects.toThrow();
        expect(readdirSync(fixture.root).sort()).toEqual(["bad.png", "source.dat"]);
    });
});

describe("image import failure boundaries", () => {
    const config = { sinks: { obsidian: false, sound: false, notify: false } } as const;

    it("cleans only newly imported files if the owning answer cannot be appended", async () => {
        const root = mkdtempSync(join(tmpdir(), "qa-failed-append-"));
        const path = join(root, "shot.png");
        writeFileSync(path, encodeRgbaToPng(new Uint8ClampedArray([1, 2, 3, 255]), 1, 1));
        const logBase = join(root, "blocked-log");
        const attachmentsRoot = join(root, "durable");
        mkdirSync(attachmentsRoot);
        writeFileSync(join(attachmentsRoot, "existing.png"), "leave this file alone");
        writeFileSync(logBase, "this is not a directory");
        await expect(
            recordAnswer(
                {
                    question: "q",
                    answer: "a",
                    tag: "question",
                    source: "cli",
                    attachments: [{ type: "image", path }],
                },
                { logBase, attachmentsRoot, config }
            )
        ).rejects.toThrow();
        expect(readdirSync(attachmentsRoot)).toEqual(["existing.png"]);
    });

    it("rejects huge header dimensions before attempting to decode pixels", async () => {
        const root = mkdtempSync(join(tmpdir(), "qa-header-limit-"));
        const bytes = encodeRgbaToPng(new Uint8ClampedArray([1, 2, 3, 255]), 1, 1);
        bytes.writeUInt32BE(100_000, 16);
        bytes.writeUInt32BE(100_000, 20);
        const path = join(root, "oversized.png");
        writeFileSync(path, bytes);
        await expect(
            recordAnswer(
                {
                    question: "q",
                    answer: "a",
                    tag: "question",
                    source: "cli",
                    attachments: [{ type: "image", path }],
                },
                { logBase: join(root, "log"), attachmentsRoot: join(root, "durable"), config }
            )
        ).rejects.toThrow("pixel limit");
        expect(readdirSync(root)).toEqual(["oversized.png"]);
    });

    it("imports real JPEG and WebP encodings after header validation", async () => {
        const root = mkdtempSync(join(tmpdir(), "qa-image-formats-"));
        const canvas = createCanvas(3, 2);
        for (const mime of ["image/jpeg", "image/webp"] as const) {
            const path = join(root, mime.split("/")[1]);
            writeFileSync(path, canvas.toBuffer(mime));
            const result = await recordAnswer(
                {
                    question: mime,
                    answer: "a",
                    tag: "question",
                    source: "cli",
                    attachments: [{ type: "image", path }],
                },
                { logBase: join(root, "log"), attachmentsRoot: join(root, "durable"), config }
            );
            expect(result.attachments?.[0]).toMatchObject({ mimeType: mime, width: 3, height: 2 });
        }
    });
});

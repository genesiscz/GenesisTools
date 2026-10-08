import { describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ai } from "@genesiscz/utils/ai/tasks/facade";
import { SafeJSON } from "@genesiscz/utils/json";
import { parseDelimited } from "@genesiscz/utils/tabular/delimited";
import { previewCorrectionExamples } from "./correction-examples";
import {
    defaultCollection,
    newRecastDocument,
    type RecastCell,
    type RecastDocument,
    type RecastSource,
    readRecastDocument,
    unknownCell,
} from "./document";
import { applyRecastOperation, type RecastOperation, recastOperationSchema } from "./operations";
import { readRecastInput, verifyRecastAssets } from "./package";
import { generateRecastProposal } from "./proposal-generation";
import { inspectRecastProposal, previewRecastProposalInput, recastProposalContext } from "./proposals";
import { previewReconciliation } from "./reconcile";
import { foldCalendarLine, RecastExportError, renderRecastCollection } from "./render";
import { previewRoundTrip } from "./roundtrip";
import { captureRecastTranscript, recastAudioSelection, reviewRecastTranscript } from "./transcription";
import { transcribeRecastSelection } from "./transcription-generation";
import { calendarInstant, recordIssues } from "./validation";

const AT = "2026-01-01T12:00:00.000Z";
const HASH = createHash("sha256").update("fixture").digest("hex");

function source(): RecastSource {
    return {
        id: "source_fixture",
        name: "Fixture.png",
        contentHash: HASH,
        assetName: `${HASH}.png`,
        kind: "image",
        mime: "image/png",
        bytes: 20,
        importedAt: AT,
        pageCount: 1,
        pages: [{ index: 0, width: 800, height: 600 }],
    };
}

function apply(document: RecastDocument, operation: RecastOperation): RecastDocument {
    return applyRecastOperation({ input: document, expectedRevision: document.revision, operation, at: AT });
}

function cell(value: RecastCell["value"], extra: Partial<RecastCell> = {}): RecastCell {
    return { ...unknownCell(), value, state: value === null ? "unknown" : "accepted", origin: "user", ...extra };
}

function example(kind: "table" | "calendar" | "checklist" = "table"): RecastDocument {
    const document = newRecastDocument({ title: "Conversion fixture" });
    document.collections = [defaultCollection(kind)];
    return apply(document, { kind: "add-record", collectionId: document.collections[0].id, id: "record_fixture" });
}

function set(document: RecastDocument, fieldId: string, value: RecastCell["value"], extra: Partial<RecastCell> = {}) {
    return apply(document, {
        kind: "set-cell",
        recordId: "record_fixture",
        fieldId,
        cell: cell(value, extra),
        reason: "Reviewed fixture correction",
    });
}

function calendar(): RecastDocument {
    let document = example("calendar");
    for (const [field, value] of Object.entries({
        title: "Fixture journey",
        start: "2026-10-06T08:40",
        end: "2026-10-06T09:20",
        timezone: "Europe/Prague",
    })) {
        document = set(document, field, value);
    }
    return apply(document, { kind: "accept-records", recordIds: ["record_fixture"] });
}

describe("Recast document identity and evidence", () => {
    test("a source anchor is tied to exact immutable source bytes", () => {
        let document = apply(example(), { kind: "add-source", source: source() });
        const anchor = {
            id: "region_fixture",
            sourceId: "source_fixture",
            sourceHash: HASH,
            label: "Timetable cell",
            region: { kind: "rect", page: 0, x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
        };
        document = apply(document, { kind: "add-anchor", anchor });
        const wrong = structuredClone(document);
        wrong.sources[0].contentHash = "f".repeat(64);
        wrong.sources[0].assetName = `${"f".repeat(64)}.png`;
        expect(() => readRecastDocument(wrong)).toThrow("different source snapshot");
        expect(document.sources[0].contentHash).toBe(HASH);
    });

    test.each([
        { kind: "rect", page: 1, x: 0, y: 0, width: 1, height: 1 },
        { kind: "rect", page: 0, x: 0.9, y: 0, width: 0.2, height: 0.5 },
        { kind: "rect", page: 0, x: 0, y: 0, width: 0, height: 1 },
        { kind: "audio", startMs: 0, endMs: 100 },
        { kind: "text", start: 0, end: 1, quote: "x" },
    ])("rejects a region outside its source capabilities: %j", (region) => {
        const document = apply(example(), { kind: "add-source", source: source() });
        expect(() =>
            apply(document, {
                kind: "add-anchor",
                anchor: {
                    id: "invalid_region",
                    sourceId: "source_fixture",
                    sourceHash: HASH,
                    label: "Invalid",
                    region,
                },
            })
        ).toThrow();
    });

    test("text ranges use UTF-16 offsets and audio ranges respect duration", () => {
        let document = example();
        document = apply(document, {
            kind: "add-source",
            source: {
                ...source(),
                id: "text_source",
                kind: "text",
                mime: "text/plain",
                assetName: `${HASH}.txt`,
                pageCount: undefined,
                pages: [],
                textLength: 4,
            },
        });
        document = apply(document, {
            kind: "add-anchor",
            anchor: {
                id: "text_region",
                sourceId: "text_source",
                sourceHash: HASH,
                label: "Emoji",
                region: { kind: "text", start: 1, end: 3, quote: "😀" },
            },
        });
        document = apply(document, {
            kind: "add-source",
            source: {
                ...source(),
                id: "audio_source",
                kind: "audio",
                mime: "audio/mp4",
                assetName: `${HASH}.m4a`,
                pageCount: undefined,
                pages: [],
                durationMs: 1000,
            },
        });
        expect(() =>
            apply(document, {
                kind: "add-anchor",
                anchor: {
                    id: "audio_region",
                    sourceId: "audio_source",
                    sourceHash: HASH,
                    label: "Outside",
                    region: { kind: "audio", startMs: 500, endMs: 1500 },
                },
            })
        ).toThrow("known source duration");
    });

    test("source filenames cannot escape the package and resource caps are explicit", () => {
        const document = example();
        expect(() =>
            apply(document, { kind: "add-source", source: { ...source(), assetName: "../outside.png" } })
        ).toThrow();
        expect(() => apply(document, { kind: "add-source", source: { ...source(), pageCount: 101 } })).toThrow();
        expect(() =>
            apply(document, {
                kind: "add-source",
                source: {
                    ...source(),
                    kind: "audio",
                    durationMs: 900001,
                },
            })
        ).toThrow();
    });
});

describe("Recast correction and acceptance", () => {
    test("correcting an interpretation preserves literal reading and both cell revisions", () => {
        let document = apply(example(), { kind: "add-source", source: source() });
        document = apply(document, {
            kind: "add-anchor",
            anchor: {
                id: "region_fixture",
                sourceId: "source_fixture",
                sourceHash: HASH,
                label: "Blurred time",
                region: { kind: "rect", page: 0, x: 0, y: 0, width: 0.5, height: 0.2 },
            },
            reading: {
                id: "reading_fixture",
                anchorId: "region_fixture",
                text: "08:10 or 08:40",
                alternatives: ["08:10", "08:40"],
                method: "vision-ocr",
                engine: "Fixture OCR",
                createdAt: AT,
            },
        });
        document = set(document, "name", "08:10", {
            origin: "inferred",
            state: "proposed",
            anchorIds: ["region_fixture"],
            readingIds: ["reading_fixture"],
            alternatives: ["08:10", "08:40"],
        });
        const before = structuredClone(document);
        document = set(document, "name", "08:40", {
            anchorIds: ["region_fixture"],
            readingIds: ["reading_fixture"],
            alternatives: ["08:10", "08:40"],
        });
        expect(document.readings).toEqual(before.readings);
        expect(document.corrections.at(-1)?.before.value).toBe("08:10");
        expect(document.corrections.at(-1)?.after.value).toBe("08:40");
        expect(before.records[0].cells.name.value).toBe("08:10");
        expect(document.records[0].state).toBe("draft");
    });

    test("unknown required fields and unsupported guesses cannot be accepted silently", () => {
        let document = example();
        expect(() => apply(document, { kind: "accept-records", recordIds: ["record_fixture"] })).toThrow("required");
        document = set(document, "name", "Guess", { origin: "inferred", state: "proposed" });
        expect(() => apply(document, { kind: "accept-records", recordIds: ["record_fixture"] })).toThrow(
            "specific readable source"
        );
        document = set(document, "name", "Explicit personal note");
        document = apply(document, { kind: "accept-records", recordIds: ["record_fixture"] });
        expect(document.records[0].cells.name.origin).toBe("user");
        expect(document.records[0].state).toBe("accepted");
    });

    test("optional typed fields reject blank strings at mutation, acceptance and export", () => {
        const values = {
            number: 42,
            boolean: false,
            date: "2026-01-01",
            datetime: "2026-01-01T12:00",
            timezone: "UTC",
        } as const;
        for (const type of Object.keys(values) as (keyof typeof values)[]) {
            const document = apply(set(example(), "name", "Reviewed"), {
                kind: "accept-records",
                recordIds: ["record_fixture"],
            });
            document.collections[0].fields.push({ id: "optional", label: "Optional", type, required: false });
            expect(() =>
                renderRecastCollection({ input: document, collectionId: document.collections[0].id, format: "csv" })
            ).not.toThrow();
            expect(() => set(document, "optional", null)).not.toThrow();
            expect(() => set(document, "optional", values[type])).not.toThrow();
            for (const value of ["", " "]) {
                expect(() => set(document, "optional", value)).toThrow();
                document.records[0].cells.optional = cell(value);
                expect(() => apply(document, { kind: "accept-records", recordIds: ["record_fixture"] })).toThrow();
                document.records[0].state = "accepted";
                expect(() =>
                    renderRecastCollection({ input: document, collectionId: document.collections[0].id, format: "csv" })
                ).toThrow(RecastExportError);
                document.records[0].state = "draft";
            }
        }
        expect(() => set(example(), "value", " ")).not.toThrow();
    });

    test("batch acceptance is atomic and stale changes fail without input mutation", () => {
        let document = set(example(), "name", "Reviewed");
        document = apply(document, {
            kind: "add-record",
            collectionId: document.collections[0].id,
            id: "record_unknown",
        });
        const before = structuredClone(document);
        expect(() =>
            apply(document, { kind: "accept-records", recordIds: ["record_fixture", "record_unknown"] })
        ).toThrow();
        expect(document).toEqual(before);
        expect(() =>
            applyRecastOperation({
                input: document,
                operation: { kind: "rename", title: "Changed" },
                expectedRevision: document.revision - 1,
                at: AT,
            })
        ).toThrow("conversion changed");
    });

    test("model-authored accepted flags are reset to proposals", () => {
        const document = example();
        const proposed = {
            ...document.records[0],
            id: "record_proposal",
            state: "accepted",
            cells: { name: cell("Unreviewed") },
        };
        const next = apply(document, { kind: "add-proposals", records: [proposed] });
        expect(next.records[1].state).toBe("draft");
        expect(next.records[1].cells.name.state).toBe("proposed");
        expect(next.records[1].cells.name.origin).toBe("inferred");
    });

    test("archive retains correction history and unsupported source attachment leaves other records usable", () => {
        let document = set(example(), "name", "Usable");
        document = apply(document, { kind: "accept-records", recordIds: ["record_fixture"] });
        document = apply(document, {
            kind: "add-source",
            source: {
                ...source(),
                kind: "unsupported",
                mime: "application/octet-stream",
                error: "No supported reader",
                pageCount: undefined,
                pages: [],
            },
        });
        expect(
            renderRecastCollection({ input: document, collectionId: document.collections[0].id, format: "json" }).text
        ).toContain("Usable");
        document = apply(document, { kind: "archive-records", recordIds: ["record_fixture"] });
        expect(document.corrections).toHaveLength(1);
        expect(document.records[0].state).toBe("archived");
    });
});

describe("Recast deterministic destination rendering", () => {
    test("CSV and JSON preserve reviewed typed values; CSV neutralizes spreadsheet formulas", () => {
        let document = set(example(), "name", "=2+3");
        document = set(document, "value", 'a,"b"\nnext');
        document = apply(document, { kind: "accept-records", recordIds: ["record_fixture"] });
        const collectionId = document.collections[0].id;
        const csv = renderRecastCollection({ input: document, collectionId, format: "csv" });
        const parsed = parseDelimited({ source: csv.text, delimiter: "," });
        expect(parsed.rows).toContainEqual(["record_fixture", "'=2+3", 'a,"b"\nnext']);
        const json = renderRecastCollection({ input: document, collectionId, format: "json" });
        expect(SafeJSON.parse(json.text)).toEqual([{ name: "=2+3", value: 'a,"b"\nnext' }]);
        expect(SafeJSON.parse(json.evidence)).toMatchObject({
            records: [{ fields: { name: { origin: "user", state: "accepted" } } }],
        });
    });

    test("a missing timezone blocks calendar export and user-supplied timezone is explicit", () => {
        const document = calendar();
        const output = renderRecastCollection({
            input: document,
            collectionId: document.collections[0].id,
            format: "ics",
            at: AT,
        });
        expect(output.text).toContain("DTSTART:20261006T064000Z\r\n");
        expect(output.text).toContain("DTEND:20261006T072000Z\r\n");
        expect(output.evidence).toContain('"origin": "user"');
        const missing = set(document, "timezone", null);
        expect(() =>
            renderRecastCollection({ input: missing, collectionId: document.collections[0].id, format: "ics" })
        ).toThrow("required");
    });

    test("rejects skipped or repeated local times unless a valid offset resolves them", () => {
        expect(() => calendarInstant("2026-03-29T02:30", "Europe/Prague")).toThrow();
        expect(() => calendarInstant("2026-10-25T02:30", "Europe/Prague")).toThrow();
        expect(calendarInstant("2026-10-25T02:30+02:00", "Europe/Prague").toString()).toBe("2026-10-25T00:30:00Z");
        expect(calendarInstant("2026-10-25T02:30+01:00", "Europe/Prague").toString()).toBe("2026-10-25T01:30:00Z");
        expect(() => calendarInstant("2026-10-25T02:30+03:00", "Europe/Prague")).toThrow();
    });

    test("escapes calendar newlines and separators and folds Unicode on octet boundaries", () => {
        let document = calendar();
        document = set(document, "title", `${"Žluťoučký 😀 ".repeat(12)}, one; two\nEND:VEVENT`);
        document = apply(document, { kind: "accept-records", recordIds: ["record_fixture"] });
        const output = renderRecastCollection({
            input: document,
            collectionId: document.collections[0].id,
            format: "ics",
            at: AT,
        });
        const lines = output.text.split("\r\n");
        expect(lines.every((line) => Buffer.byteLength(line) <= 75)).toBe(true);
        expect(lines.filter((line) => line === "END:VEVENT")).toHaveLength(1);
        expect(output.text.replace(/\r\n /g, "")).toContain("\\, one\\; two\\nEND:VEVENT");
        const raw = `DESCRIPTION:${"😀".repeat(40)}`;
        expect(foldCalendarLine(raw).replace(/\r\n /g, "")).toBe(raw);
    });

    test("Markdown checklist keeps literal content and exposes incomplete records", () => {
        let document = example("checklist");
        document = set(document, "title", "<script>bad</script> [link](url)");
        document = set(document, "done", true);
        document = apply(document, { kind: "accept-records", recordIds: ["record_fixture"] });
        const output = renderRecastCollection({
            input: document,
            collectionId: document.collections[0].id,
            format: "markdown",
        });
        expect(output.text).toContain("- [x] &lt;script&gt;");
        expect(output.text).not.toContain("<script>");
        expect(recordIssues({ document, record: document.records[0] })).toEqual([]);
    });
});

describe("Recast captured proposals and package evidence", () => {
    test("one capture publishes anchors, immutable readings and unaccepted rows atomically", () => {
        const original = apply(example(), { kind: "add-source", source: source() });
        const anchor = {
            id: "capture_anchor",
            sourceId: "source_fixture",
            sourceHash: HASH,
            label: "Captured value",
            region: { kind: "rect", page: 0, x: 0.2, y: 0.1, width: 0.3, height: 0.1 },
        };
        const reading = {
            id: "capture_reading",
            anchorId: anchor.id,
            text: "Office supplies",
            alternatives: [],
            method: "vision-ocr",
            engine: "Fixture OCR",
            createdAt: AT,
        };
        const record = {
            id: "capture_record",
            collectionId: original.collections[0].id,
            state: "accepted",
            createdAt: AT,
            cells: { name: cell(reading.text, { anchorIds: [anchor.id], readingIds: [reading.id] }) },
        };
        const next = apply(original, { kind: "capture", anchors: [anchor], readings: [reading], records: [record] });
        expect(next.records[1].state).toBe("draft");
        expect(next.records[1].cells.name.state).toBe("proposed");
        expect(next.records[1].cells.name.origin).toBe("source");
        expect(next.readings[0].text).toBe(reading.text);
        expect(original.anchors).toEqual([]);
        expect(() =>
            apply(original, {
                kind: "capture",
                anchors: [anchor],
                readings: [{ ...reading, anchorId: "missing" }],
                records: [record],
            })
        ).toThrow();
        expect(original.records).toHaveLength(1);
    });

    test("saved snapshots detect changed bytes, links, and fabricated text quotes", async () => {
        const folder = await mkdtemp(join(tmpdir(), "recast-evidence-"));
        try {
            await mkdir(join(folder, "sources"));
            const text = "Flight 😀 departs at 08:40";
            const hash = createHash("sha256").update(text).digest("hex");
            const assetName = `${hash}.txt`;
            const assetPath = join(folder, "sources", assetName);
            let document = apply(example(), {
                kind: "add-source",
                source: {
                    ...source(),
                    id: "source_text",
                    kind: "text",
                    contentHash: hash,
                    assetName,
                    mime: "text/plain",
                    bytes: Buffer.byteLength(text),
                    pageCount: undefined,
                    pages: [],
                    textLength: text.length,
                },
            });
            document = apply(document, {
                kind: "add-anchor",
                anchor: {
                    id: "text_quote",
                    sourceId: "source_text",
                    sourceHash: hash,
                    label: "Departure",
                    region: { kind: "text", start: text.length - 5, end: text.length, quote: "08:40" },
                },
            });
            await writeFile(assetPath, text);
            await writeFile(join(folder, "manifest.json"), SafeJSON.stringify(document));
            const opened = await readRecastInput(folder);
            expect(opened.document.anchors[0].region.kind).toBe("text");
            await verifyRecastAssets({ document: opened.document, packagePath: folder });
            const invented = structuredClone(document);
            if (invented.anchors[0].region.kind === "text") {
                invented.anchors[0].region.quote = "12:00";
            }
            await expect(verifyRecastAssets({ document: invented, packagePath: folder })).rejects.toThrow(
                "literal text region"
            );
            const files = await import("node:fs/promises");
            const reread = spyOn(files, "readFile").mockResolvedValue(Buffer.from(text.slice(0, -5) + "12:00"));
            try {
                await expect(verifyRecastAssets({ document: invented, packagePath: folder })).rejects.toThrow(
                    "literal text region"
                );
            } finally {
                reread.mockRestore();
            }
            await writeFile(assetPath, text.replace("08:40", "08:41"));
            await expect(verifyRecastAssets({ document, packagePath: folder })).rejects.toThrow();
            await rm(assetPath);
            const target = join(folder, "outside.txt");
            await writeFile(target, text);
            await symlink(target, assetPath);
            await expect(verifyRecastAssets({ document, packagePath: folder })).rejects.toThrow("missing or changed");
            const abort = new AbortController();
            abort.abort();
            await expect(verifyRecastAssets({ document, packagePath: folder, signal: abort.signal })).rejects.toThrow();
        } finally {
            await rm(folder, { recursive: true, force: true });
        }
    });
});

describe("Recast AI proposal review", () => {
    function context() {
        let document = apply(example(), { kind: "add-source", source: source() });
        document = apply(document, {
            kind: "add-anchor",
            anchor: {
                id: "proposal_anchor",
                sourceId: "source_fixture",
                sourceHash: HASH,
                label: "Source reading",
                region: { kind: "rect", page: 0, x: 0, y: 0, width: 0.5, height: 0.2 },
            },
            reading: {
                id: "proposal_reading",
                anchorId: "proposal_anchor",
                text: "Paper: 42 sheets",
                alternatives: [],
                method: "vision-ocr",
                engine: "Fixture OCR",
                createdAt: AT,
            },
        });
        return document;
    }

    test("only explicitly selected readings enter the preview and citation validator", () => {
        const document = context();
        document.sources[0].externalLocation = "/fixture/private-original.png";
        document.readings.push({ ...document.readings[0], id: "excluded_reading", text: "Excluded private note" });
        const args = { input: document, collectionId: document.collections[0].id, readingIds: ["proposal_reading"] };
        const preview = previewRecastProposalInput(args);
        expect(preview.serialized).toContain("Paper: 42 sheets");
        expect(preview.serialized).not.toContain("Excluded private note");
        expect(preview.serialized).not.toContain("/fixture/private-original.png");
        expect(preview.readingIds).toEqual(["proposal_reading"]);
        expect(preview.characters).toBe(preview.serialized.length);
        expect("document" in preview).toBe(false);
        expect(() =>
            inspectRecastProposal({
                document,
                collectionId: args.collectionId,
                readingIds: args.readingIds,
                input: {
                    explanation: "",
                    records: [
                        {
                            fields: [
                                {
                                    fieldId: "name",
                                    value: "Excluded private note",
                                    note: "",
                                    evidence: [{ readingId: "excluded_reading", quote: "Excluded private note" }],
                                },
                            ],
                        },
                    ],
                },
            })
        ).toThrow("outside the selected readings");
    });

    test("text-anchor surroundings never enter a selected model input", () => {
        const document = context();
        document.sources[0] = {
            ...document.sources[0],
            name: "Selected text.txt",
            mime: "text/plain",
            kind: "text",
            assetName: `${HASH}.txt`,
            pages: [],
            pageCount: undefined,
            textLength: 100,
        };
        document.anchors[0].region = {
            kind: "text",
            start: 30,
            end: 35,
            quote: "Paper",
            prefix: "Private words before selection",
            suffix: "Private words after selection",
        };
        document.readings[0].method = "manual";
        const preview = previewRecastProposalInput({
            input: document,
            collectionId: document.collections[0].id,
            readingIds: ["proposal_reading"],
        });
        expect(preview.serialized).not.toContain("Private words");
        const input = SafeJSON.parse(preview.serialized);
        expect(input.readings[0].region).toEqual({ kind: "text", start: 30, end: 35 });
        expect(input.readings[0].text).toBe("Paper: 42 sheets");
    });

    test("an explicit selection can combine image readings and audio without inventing intervals", () => {
        let document = context();
        document = apply(document, {
            kind: "add-source",
            source: {
                ...source(),
                id: "audio_source",
                kind: "audio",
                name: "Spoken note.wav",
                assetName: `${HASH}.wav`,
                mime: "audio/wav",
                pageCount: undefined,
                pages: [],
                durationMs: 10000,
            },
        });
        document = apply(document, {
            kind: "add-anchor",
            anchor: {
                id: "audio_anchor",
                sourceId: "audio_source",
                sourceHash: HASH,
                label: "Spoken interval",
                region: { kind: "audio", startMs: 2000, endMs: 5000 },
            },
            reading: {
                id: "audio_reading",
                anchorId: "audio_anchor",
                text: "Allow twenty minutes.",
                alternatives: [],
                method: "transcript",
                engine: "Fixture speech",
                createdAt: AT,
            },
        });
        const args = {
            input: document,
            collectionId: document.collections[0].id,
            readingIds: ["audio_reading", "proposal_reading"],
        };
        const chosen = recastProposalContext(args);
        expect(chosen.sourceIds).toEqual(["source_fixture", "audio_source"]);
        expect(chosen.readingIds).toEqual(["proposal_reading", "audio_reading"]);
        expect(recastProposalContext({ ...args, readingIds: [...args.readingIds].reverse() }).contextHash).toBe(
            chosen.contextHash
        );
        const review = inspectRecastProposal({
            document,
            collectionId: args.collectionId,
            readingIds: args.readingIds,
            input: {
                explanation: "",
                records: [
                    {
                        fields: [
                            {
                                fieldId: "name",
                                value: "Paper with twenty minutes",
                                note: "Review the combined interpretation.",
                                evidence: [
                                    { readingId: "proposal_reading", quote: "Paper" },
                                    { readingId: "audio_reading", quote: "twenty minutes" },
                                ],
                            },
                        ],
                    },
                ],
            },
        });
        expect(review.records[0].cells.name.anchorIds).toEqual(["proposal_anchor", "audio_anchor"]);
        expect(document.anchors.find((anchor) => anchor.id === "audio_anchor")?.region).toEqual({
            kind: "audio",
            startMs: 2000,
            endMs: 5000,
        });
        expect(review.records[0].state).toBe("draft");
    });

    test("OCR alternatives remain visible and can be cited only through selected readings", () => {
        const document = context();
        document.readings[0].alternatives = ["Paper: 47 sheets"];
        const args = { collectionId: document.collections[0].id, readingIds: ["proposal_reading"] };
        expect(recastProposalContext({ input: document, ...args }).serialized).toContain("Paper: 47 sheets");
        const review = inspectRecastProposal({
            document,
            ...args,
            input: {
                explanation: "One possible reading; inspect the original.",
                records: [
                    {
                        fields: [
                            {
                                fieldId: "value",
                                value: "47 sheets",
                                note: "OCR also read 42.",
                                evidence: [{ readingId: "proposal_reading", quote: "47 sheets" }],
                            },
                        ],
                    },
                ],
            },
        });
        expect(review.records[0].cells.value.state).toBe("proposed");
        expect(document.readings[0].text).toBe("Paper: 42 sheets");
        expect(document.readings[0].alternatives).toEqual(["Paper: 47 sheets"]);
    });

    test("selection bounds apply to chosen readings, not the whole source", () => {
        const document = context();
        document.readings.push(
            ...Array.from({ length: 210 }, (_, index) => ({
                ...document.readings[0],
                id: `other_reading_${index}`,
                text: `Other literal ${index}`,
            }))
        );
        const args = { input: document, collectionId: document.collections[0].id, readingIds: ["proposal_reading"] };
        expect(recastProposalContext(args).readings).toHaveLength(1);
        expect(() => recastProposalContext({ ...args, readingIds: [] })).toThrow();
        expect(() => recastProposalContext({ ...args, readingIds: ["proposal_reading", "proposal_reading"] })).toThrow(
            "once"
        );
        expect(() => recastProposalContext({ ...args, readingIds: ["missing_reading"] })).toThrow("missing");
        expect(() =>
            recastProposalContext({ ...args, readingIds: document.readings.map((item) => item.id) })
        ).toThrow();
        document.readings[0].text = "x".repeat(32000);
        expect(() => recastProposalContext(args)).toThrow("32,000 characters");
    });

    test("invalid selections stop before model resolution; a valid selection reaches it", async () => {
        const resolution = await import("@genesiscz/utils/ai/core/resolve");
        const resolve = spyOn(resolution, "resolveModel").mockRejectedValue(new Error("Fixture binding reached"));
        try {
            const document = context();
            const args = { input: document, collectionId: document.collections[0].id, instruction: "Extract paper." };
            await expect(generateRecastProposal({ ...args, readingIds: ["missing_reading"] })).rejects.toThrow(
                "missing"
            );
            await expect(generateRecastProposal({ ...args, readingIds: [] })).rejects.toThrow();
            expect(resolve).toHaveBeenCalledTimes(0);
            await expect(generateRecastProposal({ ...args, readingIds: ["proposal_reading"] })).rejects.toThrow(
                "Fixture binding reached"
            );
            expect(resolve).toHaveBeenCalledTimes(1);
        } finally {
            resolve.mockRestore();
        }
    });

    test("a caller cannot widen citation scope while the model call is pending", async () => {
        const resolution = await import("@genesiscz/utils/ai/core/resolve");
        const calls = await import("@genesiscz/utils/ai/core/call");
        let disposed = 0;
        const binding = {
            accountId: "acc_fixture",
            providerId: "fixture",
            billed: false,
            language: () => {
                throw new Error("No actual model may run");
            },
            dispose: () => {
                disposed++;
            },
        };
        const resolve = spyOn(resolution, "resolveModel").mockResolvedValue({
            account: {
                id: "acc_fixture",
                name: "fixture",
                provider: "fixture",
                enabled: true,
                billing: { mode: "free" },
                credentials: {},
                useEnvApiKey: false,
            },
            plugin: {
                id: "fixture",
                kind: "local",
                capabilities: new Set(["chat"]),
                credential: { fields: [], envKeys: [] },
                bind: async () => binding,
            },
            binding,
            model: { id: "fixture", provider: "fixture", unlisted: true },
            via: "fixture",
        });
        const readingIds = ["proposal_reading"];
        let excluded = true;
        let sent = "";
        const call = spyOn(calls, "callLLMStructured").mockImplementation(async (options) => {
            sent = options.userPrompt;
            readingIds.push("excluded_reading");
            const proposal = {
                explanation: "",
                records: [
                    {
                        fields: [
                            {
                                fieldId: "name",
                                value: excluded ? "Excluded private note" : "Paper",
                                note: "",
                                evidence: [
                                    {
                                        readingId: excluded ? "excluded_reading" : "proposal_reading",
                                        quote: excluded ? "Excluded private note" : "Paper",
                                    },
                                ],
                            },
                        ],
                    },
                ],
            };
            return { object: options.schema.parse(proposal), content: SafeJSON.stringify(proposal) };
        });
        try {
            const document = context();
            document.readings.push({ ...document.readings[0], id: "excluded_reading", text: "Excluded private note" });
            const args = {
                input: document,
                collectionId: document.collections[0].id,
                readingIds,
                instruction: "Extract paper.",
            };
            await expect(generateRecastProposal(args)).rejects.toThrow("outside the selected readings");
            expect(sent).not.toContain("Excluded private note");
            expect(disposed).toBe(1);
            excluded = false;
            readingIds.splice(1);
            const review = await generateRecastProposal(args);
            expect(review.readingIds).toEqual(["proposal_reading"]);
            expect(review.records[0].cells.name.value).toBe("Paper");
            expect(disposed).toBe(2);
        } finally {
            call.mockRestore();
            resolve.mockRestore();
        }
    });

    test("a quoted interpretation remains a proposal, never an accepted fact", () => {
        const document = context();
        const review = inspectRecastProposal({
            document,
            collectionId: document.collections[0].id,
            readingIds: ["proposal_reading"],
            at: AT,
            input: {
                explanation: "Review the quantity.",
                records: [
                    {
                        fields: [
                            {
                                fieldId: "name",
                                value: "Paper",
                                evidence: [{ readingId: "proposal_reading", quote: "Paper" }],
                                note: "",
                            },
                            {
                                fieldId: "value",
                                value: "42 sheets",
                                evidence: [{ readingId: "proposal_reading", quote: "42 sheets" }],
                                note: "",
                            },
                        ],
                    },
                ],
            },
        });
        expect(review.records[0].state).toBe("draft");
        expect(review.records[0].cells.value.origin).toBe("inferred");
        expect(review.records[0].cells.value.state).toBe("proposed");
        expect(review.records[0].cells.name.anchorIds).toEqual(["proposal_anchor"]);
        expect(review.revision).toBe(document.revision);
        expect(review.contextHash).toBe(
            recastProposalContext({
                input: document,
                collectionId: document.collections[0].id,
                readingIds: ["proposal_reading"],
            }).contextHash
        );
        expect(document.records).toHaveLength(1);
    });

    test("invented source references or repeated fields reject the complete proposal", () => {
        const document = context();
        const field = {
            fieldId: "name",
            value: "Paper",
            evidence: [{ readingId: "proposal_reading", quote: "invented" }],
            note: "",
        };
        const inspect = (fields: unknown[]) =>
            inspectRecastProposal({
                document,
                collectionId: document.collections[0].id,
                readingIds: ["proposal_reading"],
                input: { explanation: "", records: [{ fields }] },
            });
        expect(() => inspect([field])).toThrow("quotation");
        const valid = { ...field, evidence: [{ readingId: "proposal_reading", quote: "Paper" }] };
        expect(() => inspect([valid, valid])).toThrow("repeated field");
        expect(() => inspect([{ ...valid, fieldId: "absent_field" }])).toThrow("unknown");
    });

    test("ungrounded values stay unknown with an explicit review question", () => {
        const document = context();
        const review = inspectRecastProposal({
            document,
            collectionId: document.collections[0].id,
            readingIds: ["proposal_reading"],
            input: {
                explanation: "",
                records: [{ fields: [{ fieldId: "name", value: "A guess", evidence: [], note: "Probably" }] }],
            },
        });
        expect(review.records[0].cells.name.value).toBeNull();
        expect(review.records[0].cells.name.state).toBe("unknown");
        expect(review.warnings).toHaveLength(1);
        expect(() =>
            recastProposalContext({
                input: example(),
                collectionId: "missing",
                readingIds: ["proposal_reading"],
            })
        ).toThrow();
    });
});

describe("Recast CSV round-trip proposals", () => {
    function exported(value: string) {
        let document = set(example(), "name", value);
        document = apply(document, { kind: "accept-records", recordIds: ["record_fixture"] });
        const rendering = renderRecastCollection({
            input: document,
            collectionId: document.collections[0].id,
            format: "csv",
            at: AT,
        });
        document = apply(document, { kind: "record-rendering", receipt: rendering.receipt });
        return { document, rendering };
    }

    test("an unchanged CSV preserves newer local corrections and protected formula strings", () => {
        const { document, rendering } = exported("=SUM(A1:A3)");
        const corrected = set(document, "name", "A newer local correction");
        const preview = previewRoundTrip({ input: corrected, receiptId: rendering.receipt.id, csv: rendering.text });
        expect(preview.changes).toEqual([]);
        expect(preview.unchanged).toBe(2);
        expect(corrected.records[0].cells.name.value).toBe("A newer local correction");
    });

    test("external edits become reviewed draft corrections without replacing literal evidence", () => {
        const { document, rendering } = exported("Original");
        const csv = rendering.text.replace("Original", "Edited outside");
        const preview = previewRoundTrip({ input: document, receiptId: rendering.receipt.id, csv });
        expect(preview.changes).toHaveLength(1);
        expect(preview.changes[0].status).toBe("change");
        const next = apply(document, {
            kind: "apply-roundtrip",
            receiptId: rendering.receipt.id,
            csv,
            importChangeIds: [preview.changes[0].id],
        });
        expect(next.records[0].cells.name.value).toBe("Edited outside");
        expect(next.records[0].state).toBe("draft");
        expect(next.records[0].cells.name.origin).toBe("user");
        expect(next.corrections.at(-1)?.before.value).toBe("Original");
        expect(document.records[0].cells.name.value).toBe("Original");
    });

    test("both-sided changes are explicit conflicts; removed rows propose archive", () => {
        const { document, rendering } = exported("Original");
        const current = set(document, "name", "Local edit");
        const csv = rendering.text.replace("Original", "External edit");
        const conflict = previewRoundTrip({ input: current, receiptId: rendering.receipt.id, csv });
        expect(conflict.changes[0]).toMatchObject({
            status: "conflict",
            base: "Original",
            current: "Local edit",
            incoming: "External edit",
        });
        const removed = `${rendering.text.split("\r\n")[0]}\r\n`;
        const archive = previewRoundTrip({ input: current, receiptId: rendering.receipt.id, csv: removed });
        expect(archive.changes[0]).toMatchObject({ kind: "archive", status: "conflict" });
        const archived = apply(current, {
            kind: "apply-roundtrip",
            receiptId: rendering.receipt.id,
            csv: removed,
            importChangeIds: [archive.changes[0].id],
        });
        expect(archived.records[0].state).toBe("archived");
        expect(archived.records[0].cells.name.value).toBe("Local edit");
        expect(archived.corrections).toEqual(current.corrections);
        const archivedEdit = previewRoundTrip({ input: archived, receiptId: rendering.receipt.id, csv });
        expect(archivedEdit.changes[0].status).toBe("invalid");
        expect(() =>
            apply(archived, {
                kind: "apply-roundtrip",
                receiptId: rendering.receipt.id,
                csv,
                importChangeIds: [archivedEdit.changes[0].id],
            })
        ).toThrow("archived");
    });

    test("unknown identities, duplicate rows and renamed headers cannot be mapped by position", () => {
        const { document, rendering } = exported("Original");
        const preview = (csv: string) => previewRoundTrip({ input: document, receiptId: rendering.receipt.id, csv });
        expect(() => preview(rendering.text.replace("record_fixture", "record_foreign"))).toThrow("unknown");
        expect(() => preview(`${rendering.text + rendering.text.split("\r\n")[1]}\r\n`)).toThrow("repeated");
        expect(() => preview(rendering.text.replace(",name,", ",renamed,"))).toThrow("header");
        expect(() =>
            apply(document, {
                kind: "apply-roundtrip",
                receiptId: rendering.receipt.id,
                csv: rendering.text.replace("Original", "External"),
                importChangeIds: ["record_fixture:absent"],
            })
        ).toThrow("current CSV comparison");
    });

    test("column order is irrelevant and invalid numeric edits cannot partly apply", () => {
        let document = example();
        document.collections[0].fields[1].type = "number";
        document = set(set(document, "name", "Item"), "value", 42);
        document = apply(document, { kind: "accept-records", recordIds: ["record_fixture"] });
        const rendering = renderRecastCollection({
            input: document,
            collectionId: document.collections[0].id,
            format: "csv",
            at: AT,
        });
        document = apply(document, { kind: "record-rendering", receipt: rendering.receipt });
        const csv = "value,__recast_record_id,name\r\nwrong,record_fixture,Changed\r\n";
        const preview = previewRoundTrip({ input: document, receiptId: rendering.receipt.id, csv });
        expect(preview.changes.find((entry) => entry.fieldId === "value")?.status).toBe("invalid");
        expect(() =>
            apply(document, {
                kind: "apply-roundtrip",
                receiptId: rendering.receipt.id,
                csv,
                importChangeIds: preview.changes.map((entry) => entry.id),
            })
        ).toThrow("number");
        expect(document.records[0].cells.name.value).toBe("Item");
        expect(
            previewRoundTrip({
                input: document,
                receiptId: rendering.receipt.id,
                csv: "value,__recast_record_id,name\r\n42,record_fixture,Item\r\n",
            }).changes
        ).toEqual([]);
    });
});

describe("Recast source replacement review", () => {
    function fixture() {
        let document = apply(example(), { kind: "add-source", source: source() });
        document = apply(document, {
            kind: "add-anchor",
            anchor: {
                id: "old_anchor",
                sourceId: "source_fixture",
                sourceHash: HASH,
                label: "Departure",
                region: { kind: "rect", page: 0, x: 0.1, y: 0.2, width: 0.4, height: 0.1 },
            },
            reading: {
                id: "old_reading",
                anchorId: "old_anchor",
                text: "Departure at 08:10",
                alternatives: ["08:40"],
                method: "vision-ocr",
                engine: "Fixture OCR",
                createdAt: AT,
            },
        });
        document = set(document, "name", "Departure at 08:40", {
            anchorIds: ["old_anchor"],
            readingIds: ["old_reading"],
        });
        document = apply(document, { kind: "accept-records", recordIds: ["record_fixture"] });
        document = apply(document, {
            kind: "add-source",
            source: {
                ...source(),
                id: "replacement",
                name: "Revised.png",
                contentHash: "a".repeat(64),
                assetName: `${"a".repeat(64)}.png`,
            },
        });
        return document;
    }

    test("an unrelated replacement keeps original corrections and prevents silently accepting stale evidence", () => {
        let document = fixture();
        const before = structuredClone(document);
        document = apply(document, {
            kind: "start-reconciliation",
            oldSourceId: "source_fixture",
            newSourceId: "replacement",
            id: "source_review",
        });
        const preview = previewReconciliation({
            input: document,
            oldSourceId: "source_fixture",
            newSourceId: "replacement",
            jobId: "source_review",
        });
        expect(preview.items[0]).toMatchObject({ match: "unmatched", decision: "pending", candidates: [] });
        expect(document.corrections).toEqual(before.corrections);
        expect(document.records[0].cells.name.value).toBe("Departure at 08:40");
        expect(document.records[0].cells.name.anchorIds).toEqual(["old_anchor"]);
        expect(document.records[0].state).toBe("draft");
        expect(() => apply(document, { kind: "accept-records", recordIds: ["record_fixture"] })).toThrow(
            "replaced source"
        );
        document = apply(document, {
            kind: "resolve-reconciliation",
            jobId: "source_review",
            resolutions: [{ oldAnchorId: "old_anchor", decision: "keep" }],
        });
        document = apply(document, { kind: "accept-records", recordIds: ["record_fixture"] });
        expect(document.records[0].cells.name.anchorIds).toEqual(["old_anchor"]);
        expect(document.reconciliations[0].items[0].status).toBe("kept");
        expect(
            renderRecastCollection({ input: document, collectionId: document.collections[0].id, format: "csv" }).text
        ).toContain("08:40");
    });

    test("reviewed relinking preserves old readings and corrections while requiring another value review", () => {
        let document = fixture();
        document = apply(document, {
            kind: "add-anchor",
            anchor: {
                id: "new_anchor",
                sourceId: "replacement",
                sourceHash: "a".repeat(64),
                label: "New departure",
                region: { kind: "rect", page: 0, x: 0.1, y: 0.2, width: 0.4, height: 0.1 },
            },
            reading: {
                id: "new_reading",
                anchorId: "new_anchor",
                text: "Departure at 08:20",
                alternatives: [],
                method: "vision-ocr",
                engine: "Fixture OCR",
                createdAt: AT,
            },
        });
        document = apply(document, {
            kind: "start-reconciliation",
            oldSourceId: "source_fixture",
            newSourceId: "replacement",
            id: "source_review",
        });
        const original = structuredClone(document);
        document = apply(document, {
            kind: "resolve-reconciliation",
            jobId: "source_review",
            resolutions: [{ oldAnchorId: "old_anchor", decision: "relink", newAnchorId: "new_anchor" }],
        });
        expect(document.records[0].cells.name).toMatchObject({
            value: "Departure at 08:40",
            state: "proposed",
            origin: "user",
            anchorIds: ["new_anchor"],
            readingIds: ["new_reading"],
        });
        expect(document.readings.find((reading) => reading.id === "old_reading")?.text).toBe("Departure at 08:10");
        expect(document.corrections.at(-1)?.before.anchorIds).toEqual(["old_anchor"]);
        expect(original.records[0].cells.name.anchorIds).toEqual(["old_anchor"]);
        expect(document.reconciliations[0].items[0].status).toBe("relinked");
        expect(() =>
            renderRecastCollection({ input: document, collectionId: document.collections[0].id, format: "csv" })
        ).toThrow("accepted");
    });

    test("identical snapshots offer unchanged regions but never transfer them without review", () => {
        let document = fixture();
        document.sources[1] = { ...source(), id: "replacement" };
        document = apply(document, {
            kind: "start-reconciliation",
            oldSourceId: "source_fixture",
            newSourceId: "replacement",
            id: "source_review",
        });
        const preview = previewReconciliation({
            input: document,
            oldSourceId: "source_fixture",
            newSourceId: "replacement",
            jobId: "source_review",
        });
        expect(preview.items[0].match).toBe("unchanged");
        expect(preview.items[0].candidates).toHaveLength(1);
        expect(document.records[0].cells.name.anchorIds).toEqual(["old_anchor"]);
        expect(document.reconciliations[0].items[0].status).toBe("pending");
        document.sources[0].replaces = "replacement";
        expect(() => readRecastDocument(document)).toThrow("cycle");
    });

    test("repeated readings stay ambiguous and offer bounded candidates", () => {
        let document = fixture();
        const anchors = Array.from({ length: 100 }, (_, index) => ({
            id: `new_anchor_${index}`,
            sourceId: "replacement",
            sourceHash: "a".repeat(64),
            label: "Repeated departure",
            region: { kind: "rect", page: 0, x: 0.1, y: 0.2, width: 0.4, height: 0.1 },
        }));
        const readings = anchors.map((anchor, index) => ({
            id: `new_reading_${index}`,
            anchorId: anchor.id,
            text: "Departure at 08:10",
            alternatives: [],
            method: "vision-ocr",
            engine: "Fixture OCR",
            createdAt: AT,
        }));
        document = apply(document, { kind: "capture", anchors, readings, records: [] });
        const preview = previewReconciliation({
            input: document,
            oldSourceId: "source_fixture",
            newSourceId: "replacement",
        });
        expect(preview.items[0]).toMatchObject({ match: "ambiguous", candidateCount: 100 });
        expect(preview.items[0].candidates).toHaveLength(8);
        expect(document.records[0].state).toBe("accepted");
    });

    test("failed reconciliation decisions cannot partly rewrite source links", () => {
        const document = apply(fixture(), {
            kind: "start-reconciliation",
            oldSourceId: "source_fixture",
            newSourceId: "replacement",
            id: "source_review",
        });
        expect(() =>
            apply(document, {
                kind: "resolve-reconciliation",
                jobId: "source_review",
                resolutions: [
                    { oldAnchorId: "old_anchor", decision: "keep" },
                    { oldAnchorId: "missing", decision: "keep" },
                ],
            })
        ).toThrow();
        expect(document.reconciliations[0].items[0].status).toBe("pending");
        expect(document.records[0].cells.name.anchorIds).toEqual(["old_anchor"]);
    });
});

describe("Recast audio evidence", () => {
    test.skipIf(!Bun.which("ffmpeg"))(
        "verifies and clips original bytes before the facade and cleans the temporary clip",
        async () => {
            const folder = await mkdtemp(join(tmpdir(), "recast-audio-fixture-"));
            const inputPath = join(folder, "recording.wav");
            const wav = Buffer.alloc(64044);
            wav.write("RIFF", 0);
            wav.writeUInt32LE(64036, 4);
            wav.write("WAVEfmt ", 8);
            wav.writeUInt32LE(16, 16);
            wav.writeUInt16LE(1, 20);
            wav.writeUInt16LE(1, 22);
            wav.writeUInt32LE(16000, 24);
            wav.writeUInt32LE(32000, 28);
            wav.writeUInt16LE(2, 32);
            wav.writeUInt16LE(16, 34);
            wav.write("data", 36);
            wav.writeUInt32LE(64000, 40);
            const hash = createHash("sha256").update(wav).digest("hex");
            const input = apply(example(), {
                kind: "add-source",
                source: {
                    ...source(),
                    kind: "audio",
                    name: "recording.wav",
                    assetName: `${hash}.wav`,
                    contentHash: hash,
                    bytes: wav.length,
                    mime: "audio/wav",
                    pageCount: undefined,
                    pages: [],
                    durationMs: 2000,
                },
            });
            const originalDocumentId = input.id;
            const originalRevision = input.revision;
            let capturedClip = "";
            const transcribe = spyOn(ai, "transcribe").mockImplementation(async (audio, options) => {
                expect(typeof audio).toBe("string");
                capturedClip = String(audio);
                expect(await Bun.file(capturedClip).exists()).toBe(true);
                expect(options?.app).toBe("recast");
                expect(options?.signal?.aborted).toBe(false);
                input.id = "replacement_conversion";
                input.revision++;
                return {
                    text: "Fixture speech.",
                    segments: [{ text: "Fixture speech.", start: 0.1, end: 0.5 }],
                    provider: "fixture",
                    model: "speech",
                };
            });
            try {
                await writeFile(inputPath, wav);
                const review = await transcribeRecastSelection({
                    input,
                    sourceId: "source_fixture",
                    audioPath: inputPath,
                    startMs: 500,
                    endMs: 1500,
                });
                expect(review.engine).toBe("fixture/speech");
                expect(review.documentId).toBe(originalDocumentId);
                expect(review.revision).toBe(originalRevision);
                expect(() =>
                    captureRecastTranscript({
                        input,
                        review,
                        collectionId: input.collections[0].id,
                        mode: "readings",
                    })
                ).toThrow("conversion changed");
                expect(review.segments[0]).toMatchObject({ startMs: 600, endMs: 1000 });
                expect(await Bun.file(capturedClip).exists()).toBe(false);
                expect(transcribe).toHaveBeenCalledTimes(1);
                wav[44] = 1;
                await writeFile(inputPath, wav);
                await expect(
                    transcribeRecastSelection({
                        input,
                        sourceId: "source_fixture",
                        audioPath: inputPath,
                        startMs: 500,
                        endMs: 1500,
                    })
                ).rejects.toThrow("bytes changed");
                expect(transcribe).toHaveBeenCalledTimes(1);
            } finally {
                transcribe.mockRestore();
                await rm(folder, { recursive: true, force: true });
            }
        }
    );

    function audioDocument() {
        return apply(example(), {
            kind: "add-source",
            source: {
                ...source(),
                kind: "audio",
                name: "fixture.wav",
                assetName: `${HASH}.wav`,
                mime: "audio/wav",
                pageCount: undefined,
                pages: [],
                durationMs: 30000,
            },
        });
    }

    function review(input: RecastDocument, result = { text: "First sentence. Second sentence." }) {
        return reviewRecastTranscript({
            input,
            sourceId: "source_fixture",
            startMs: 10000,
            endMs: 20000,
            result,
            engine: "fixture/transcriber",
        });
    }

    test("requires a real positive interval in an audio source", () => {
        const input = audioDocument();
        for (const [startMs, endMs] of [
            [-1, 10],
            [10, 10],
            [20, 10],
            [0, 30001],
            [NaN, 10],
        ]) {
            expect(() => recastAudioSelection({ input, sourceId: "source_fixture", startMs, endMs })).toThrow(
                "interval"
            );
        }
        expect(() => review(example())).toThrow("audio source");
        expect(
            recastAudioSelection({ input, sourceId: "source_fixture", startMs: 1, endMs: 30000 }).source.durationMs
        ).toBe(30000);
    });

    test("missing or invalid model timing retains the whole selection without fabricated word positions", () => {
        const input = audioDocument();
        const untimed = review(input);
        expect(untimed.timing).toBe("selection");
        expect(untimed.segments).toEqual([]);
        const invalid = reviewRecastTranscript({
            input,
            sourceId: "source_fixture",
            startMs: 10000,
            endMs: 20000,
            engine: "fixture/transcriber",
            result: { text: "Original text", segments: [{ text: "Original text", start: 0, end: 10.08 }] },
        });
        expect(invalid.timing).toBe("selection");
        expect(invalid.text).toBe("Original text");
        const operations = captureRecastTranscript({
            input,
            review: invalid,
            collectionId: input.collections[0].id,
            mode: "readings",
            at: AT,
        });
        const next = apply(input, operations[0]);
        expect(next.anchors[0].region).toEqual({ kind: "audio", startMs: 10000, endMs: 20000 });
        expect(next.readings[0].text).toBe("Original text");
        expect(next.records).toEqual(input.records);
    });

    test("provider timings are shifted into source time while the complete transcript is preserved", () => {
        const input = audioDocument();
        const transcript = reviewRecastTranscript({
            input,
            sourceId: "source_fixture",
            startMs: 10000,
            endMs: 20000,
            engine: "fixture/transcriber",
            result: {
                text: "First sentence. Second sentence.",
                segments: [
                    { text: "first sentence", start: 0.5, end: 1.5 },
                    { text: "second sentence", start: 3, end: 4 },
                ],
            },
        });
        expect(transcript.segments[0]).toEqual({ text: "first sentence", startMs: 10500, endMs: 11500 });
        const operations = captureRecastTranscript({
            input,
            review: transcript,
            collectionId: input.collections[0].id,
            mode: "rows",
            at: AT,
        });
        const next = apply(input, operations[0]);
        expect(next.anchors).toHaveLength(3);
        expect(next.readings[0].text).toBe("First sentence. Second sentence.");
        expect(next.records.slice(1).map((record) => [record.state, record.cells.name.value])).toEqual([
            ["draft", "first sentence"],
            ["draft", "second sentence"],
        ]);
        expect(() =>
            renderRecastCollection({ input: next, collectionId: input.collections[0].id, format: "csv" })
        ).toThrow();
    });

    test("reading into a field retains its prior correction and remains a proposal", () => {
        const input = set(audioDocument(), "name", "Earlier user correction");
        const operations = captureRecastTranscript({
            input,
            review: review(input),
            collectionId: input.collections[0].id,
            mode: "field",
            recordId: "record_fixture",
            fieldId: "name",
            at: AT,
        });
        let next = input;
        for (const operation of operations) {
            next = apply(next, operation);
        }
        expect(next.corrections.at(-1)?.before.value).toBe("Earlier user correction");
        expect(next.records[0].cells.name.state).toBe("proposed");
        expect(next.records[0].cells.name.anchorIds).toHaveLength(1);
        expect(next.readings[0].method).toBe("transcript");
    });

    test("a stale or forged review cannot attach to a different source state", () => {
        const input = audioDocument();
        const transcript = review(input);
        const capture = (document: RecastDocument, value: unknown) =>
            captureRecastTranscript({
                input: document,
                review: value,
                collectionId: input.collections[0].id,
                mode: "readings",
            });
        expect(() => capture(apply(input, { kind: "rename", title: "Changed" }), transcript)).toThrow("changed");
        expect(() => capture(input, { ...transcript, sourceHash: "a".repeat(64) })).toThrow("changed");
        expect(() =>
            capture(input, {
                ...transcript,
                timing: "segments",
                segments: [{ text: "bad", startMs: 9000, endMs: 11000 }],
            })
        ).toThrow("outside");
        expect(input.anchors).toHaveLength(0);
    });

    test("blank or oversized output never becomes a partial literal reading", () => {
        const input = audioDocument();
        expect(() => review(input, { text: " " })).toThrow("No speech");
        expect(() => review(input, { text: "a".repeat(32001) })).toThrow("shorter interval");
    });
});

describe("Recast evidence attachment", () => {
    function fixture(): RecastDocument {
        let document = apply(example(), { kind: "add-source", source: source() });
        document = apply(document, {
            kind: "add-source",
            source: { ...source(), id: "source_other", name: "Travel note.png" },
        });
        for (const [index, sourceId] of ["source_fixture", "source_other"].entries()) {
            document = apply(document, {
                kind: "add-anchor",
                anchor: {
                    id: `region_${index}`,
                    sourceId,
                    sourceHash: HASH,
                    label: `Region ${index + 1}`,
                    region: { kind: "rect", page: 0, x: 0, y: 0, width: 0.5, height: 0.5 },
                },
                reading: {
                    id: `reading_${index}`,
                    anchorId: `region_${index}`,
                    text: index === 0 ? "08:10" : "Allow 20 minutes",
                    alternatives: index === 0 ? ["08:40"] : [],
                    method: "manual",
                    engine: "fixture",
                    createdAt: AT,
                },
            });
        }
        document = set(document, "name", "08:40", {
            origin: "inferred",
            anchorIds: ["region_0"],
            readingIds: ["reading_0"],
            alternatives: ["08:10"],
            note: "Reviewed against timetable",
        });
        return apply(document, { kind: "accept-records", recordIds: ["record_fixture"] });
    }

    test("adding a region to an accepted field also invalidates field acceptance", () => {
        const document = fixture();
        const next = apply(document, {
            kind: "attach-anchor",
            recordId: "record_fixture",
            fieldId: "name",
            anchorId: "region_1",
        });
        expect(next.records[0].cells.name.state).toBe("proposed");
        expect(next.records[0].state).toBe("draft");
        expect(next.corrections.at(-1)?.before.state).toBe("accepted");
        expect(next.corrections.at(-1)?.after.state).toBe("proposed");
    });

    test("changing multiple attachments preserves value and source readings, records the correction and requires review", () => {
        const document = fixture();
        const before = SafeJSON.stringify(document);
        const next = apply(document, {
            kind: "set-evidence",
            recordId: "record_fixture",
            fieldId: "name",
            anchorIds: ["region_0", "region_1"],
            readingIds: ["reading_0", "reading_1"],
            reason: "Added the transfer note",
        });
        expect(next.records[0].cells.name).toEqual({
            ...document.records[0].cells.name,
            state: "proposed",
            anchorIds: ["region_0", "region_1"],
            readingIds: ["reading_0", "reading_1"],
        });
        expect(next.readings).toEqual(document.readings);
        expect(next.corrections.at(-1)?.reason).toBe("Added the transfer note");
        expect(SafeJSON.stringify(document)).toBe(before);
        expect(() =>
            renderRecastCollection({ input: next, collectionId: next.collections[0].id, format: "csv" })
        ).toThrow("accepted");
        const reviewed = apply(next, { kind: "accept-records", recordIds: ["record_fixture"] });
        const rendered = renderRecastCollection({
            input: reviewed,
            collectionId: reviewed.collections[0].id,
            format: "csv",
        });
        const proof = SafeJSON.parse(rendered.evidence);
        expect(
            proof.records[0].fields.name.evidence.map(
                (entry: { literalReadings: Array<{ id: string }> }) => entry.literalReadings[0].id
            )
        ).toEqual(["reading_0", "reading_1"]);
    });

    test("removing evidence keeps the original readings but does not make an inferred value manually supplied", () => {
        const document = fixture();
        const next = apply(document, {
            kind: "set-evidence",
            recordId: "record_fixture",
            fieldId: "name",
            anchorIds: [],
            readingIds: [],
            reason: "Neither source supports this value",
        });
        expect(next.records[0].cells.name.origin).toBe("inferred");
        expect(next.records[0].cells.name.value).toBe("08:40");
        expect(next.readings).toEqual(document.readings);
        expect(() => apply(next, { kind: "accept-records", recordIds: ["record_fixture"] })).toThrow(
            "specific readable source"
        );
    });

    test("rejects duplicate, mismatched, missing and oversized links without mutating input", () => {
        const document = fixture();
        const before = SafeJSON.stringify(document);
        for (const ids of [
            { anchorIds: ["region_0", "region_0"], readingIds: [] },
            { anchorIds: ["region_0"], readingIds: ["reading_1"] },
            { anchorIds: ["missing"], readingIds: [] },
            { anchorIds: ["region_0"], readingIds: ["reading_0", "reading_0"] },
            { anchorIds: Array.from({ length: 17 }, (_, index) => `region_${index}`), readingIds: [] },
        ]) {
            expect(() =>
                apply(document, {
                    kind: "set-evidence",
                    recordId: "record_fixture",
                    fieldId: "name",
                    reason: "Fixture",
                    ...ids,
                })
            ).toThrow();
            expect(SafeJSON.stringify(document)).toBe(before);
        }
    });

    test("unknown fields remain unknown and archived records cannot acquire new evidence", () => {
        const document = fixture();
        const next = apply(document, {
            kind: "set-evidence",
            recordId: "record_fixture",
            fieldId: "value",
            anchorIds: ["region_1"],
            readingIds: ["reading_1"],
            reason: "Context for later review",
        });
        expect(next.records[0].cells.value.value).toBeNull();
        expect(next.records[0].cells.value.state).toBe("unknown");
        const archived = apply(next, { kind: "archive-records", recordIds: ["record_fixture"] });
        expect(() =>
            apply(archived, {
                kind: "set-evidence",
                recordId: "record_fixture",
                fieldId: "name",
                anchorIds: [],
                readingIds: [],
                reason: "Fixture",
            })
        ).toThrow("archived");
    });
});

describe("explicit competing-evidence review", () => {
    function competing() {
        let document = example();
        document = set(document, "name", "Station departure");
        document = set(document, "value", "08:40");
        document = apply(document, {
            kind: "add-record",
            collectionId: document.collections[0].id,
            id: "record_other",
        });
        document = apply(document, {
            kind: "set-cell",
            recordId: "record_other",
            fieldId: "name",
            cell: cell("Station departure"),
            reason: "Fixture",
        });
        document = apply(document, {
            kind: "set-cell",
            recordId: "record_other",
            fieldId: "value",
            cell: cell("08:10"),
            reason: "Fixture",
        });
        return apply(document, { kind: "accept-records", recordIds: ["record_fixture", "record_other"] });
    }
    function start(document: RecastDocument) {
        return apply(document, {
            kind: "start-contradiction",
            id: "review_fixture",
            collectionId: document.collections[0].id,
            fieldId: "value",
            recordIds: ["record_fixture", "record_other"],
            label: "Same journey",
            reason: "Both describe the same journey",
        });
    }
    test("v1 migration preserves data, requires v2 for reviews and refuses future formats", () => {
        const current = competing();
        const { contradictions: _reviews, ...legacy } = current;
        const migrated = readRecastDocument({ ...legacy, version: 1 });
        expect(migrated.version).toBe(2);
        expect(migrated.records).toEqual(current.records);
        expect(migrated.contradictions).toEqual([]);
        expect(() => readRecastDocument({ ...current, version: 1 })).toThrow("version 2");
        expect(() => readRecastDocument({ ...current, version: 3 })).toThrow();
        expect(() => readRecastDocument({ ...legacy, version: 2 })).toThrow();
    });
    test("different strings alone stay exportable, an explicit review blocks both records", () => {
        const document = competing();
        expect(document.contradictions).toEqual([]);
        expect(
            renderRecastCollection({ input: document, collectionId: document.collections[0].id, format: "csv" })
                .recordIds
        ).toHaveLength(2);
        const pending = start(document);
        expect(() => apply(pending, { kind: "accept-records", recordIds: ["record_fixture"] })).toThrow(
            "competing evidence"
        );
        expect(() =>
            renderRecastCollection({
                input: pending,
                collectionId: pending.collections[0].id,
                format: "json",
                recordIds: ["record_other"],
            })
        ).toThrow("competing evidence");
        expect(document.records.every((record) => record.state === "accepted")).toBe(true);
    });
    test("keep both retains values and evidence, needs acceptance, and survives rendering", () => {
        const original = competing();
        let document = start(original);
        document = apply(document, {
            kind: "resolve-contradiction",
            reviewId: "review_fixture",
            decision: "keep-both",
            reason: "Retain both supplied versions",
        });
        expect(document.records.map((record) => record.cells)).toEqual(original.records.map((record) => record.cells));
        expect(document.records.every((record) => record.state === "draft")).toBe(true);
        document = apply(document, { kind: "accept-records", recordIds: ["record_fixture", "record_other"] });
        expect(document.contradictions[0].status).toBe("resolved");
        const rendered = renderRecastCollection({
            input: document,
            collectionId: document.collections[0].id,
            format: "csv",
        });
        expect(rendered.recordIds).toHaveLength(2);
        expect(SafeJSON.parse(rendered.evidence).contradictions).toHaveLength(1);
    });
    test("prefer archives losing records, context can restore both without rewriting cells", () => {
        let document = start(competing());
        document = apply(document, {
            kind: "resolve-contradiction",
            reviewId: "review_fixture",
            decision: "prefer",
            preferredRecordId: "record_fixture",
            reason: "Use the revised departure",
        });
        expect(document.records[1].state).toBe("archived");
        expect(document.records[1].cells.value.value).toBe("08:10");
        document = apply(document, { kind: "accept-records", recordIds: ["record_fixture"] });
        expect(
            renderRecastCollection({ input: document, collectionId: document.collections[0].id, format: "csv" })
                .recordIds
        ).toEqual(["record_fixture"]);
        document = apply(document, {
            kind: "resolve-contradiction",
            reviewId: "review_fixture",
            decision: "context",
            contexts: { record_fixture: "Weekdays", record_other: "Weekends" },
            reason: "Schedules apply on different days",
        });
        expect(document.records.every((record) => record.state === "draft")).toBe(true);
        expect(document.contradictions[0].members.map((member) => member.context)).toEqual(["Weekdays", "Weekends"]);
        document = apply(document, { kind: "accept-records", recordIds: ["record_fixture", "record_other"] });
        expect(
            renderRecastCollection({ input: document, collectionId: document.collections[0].id, format: "json" })
                .evidence
        ).toContain("Weekends");
    });
    test("changed values, origins, notes or evidence reopen a resolved comparison", () => {
        let reviewed = start(competing());
        reviewed = apply(reviewed, {
            kind: "resolve-contradiction",
            reviewId: "review_fixture",
            decision: "keep-both",
            reason: "Retain both",
        });
        reviewed = apply(reviewed, { kind: "accept-records", recordIds: ["record_fixture", "record_other"] });
        for (const changed of [cell("08:50"), cell("08:40", { note: "Only holidays" })]) {
            const next = apply(reviewed, {
                kind: "set-cell",
                recordId: "record_fixture",
                fieldId: "value",
                cell: changed,
                reason: "Changed fixture",
            });
            expect(next.contradictions[0].status).toBe("pending");
            expect(next.contradictions[0].decision).toBeUndefined();
            expect(next.records.every((record) => record.state === "draft")).toBe(true);
        }
        const unrelated = apply(reviewed, {
            kind: "set-cell",
            recordId: "record_fixture",
            fieldId: "name",
            cell: cell("Revised heading"),
            reason: "Heading",
        });
        expect(unrelated.contradictions[0].status).toBe("resolved");
        const archived = apply(reviewed, { kind: "archive-records", recordIds: ["record_other"] });
        expect(archived.contradictions[0].status).toBe("pending");
        expect(() => apply(archived, { kind: "accept-records", recordIds: ["record_fixture"] })).toThrow();
    });
    test("invalid groups and decisions are atomic and cannot lose record identities", () => {
        const document = competing();
        expect(() =>
            apply(document, {
                kind: "start-contradiction",
                collectionId: document.collections[0].id,
                fieldId: "value",
                recordIds: ["record_fixture", "record_fixture"],
                label: "Fixture",
                reason: "Fixture",
            })
        ).toThrow();
        const pending = start(document);
        const invalidOperations: RecastOperation[] = [
            {
                kind: "resolve-contradiction",
                reviewId: "review_fixture",
                decision: "prefer",
                preferredRecordId: "unknown",
                reason: "Fixture",
            },
            {
                kind: "resolve-contradiction",
                reviewId: "review_fixture",
                decision: "context",
                contexts: { record_fixture: "Weekdays" },
                reason: "Fixture",
            },
            {
                kind: "resolve-contradiction",
                reviewId: "review_fixture",
                decision: "context",
                contexts: { record_fixture: "Weekdays", record_other: "Weekends", unknown: "Other" },
                reason: "Fixture",
            },
        ];
        for (const operation of invalidOperations) {
            expect(() => apply(pending, operation)).toThrow();
        }
        expect(pending.contradictions[0].status).toBe("pending");
        const broken = structuredClone(pending);
        broken.contradictions[0].members[0].recordId = "missing";
        expect(() => readRecastDocument(broken)).toThrow("same collection");
    });
});

describe("bounded replacement matching", () => {
    function matching(kind: "text" | "image") {
        const document = example();
        document.sources = [
            source(),
            { ...source(), id: "replacement", contentHash: "b".repeat(64), assetName: "b".repeat(64) + ".png" },
        ];
        if (kind === "text") {
            document.sources = document.sources.map((entry) => ({
                ...entry,
                kind: "text",
                mime: "text/plain",
                pageCount: undefined,
                pages: [],
                textLength: 1000,
            }));
        }
        document.anchors = [
            {
                id: "old_anchor",
                sourceId: "source_fixture",
                sourceHash: HASH,
                label: "Departure",
                region:
                    kind === "image"
                        ? { kind: "rect", page: 0, x: 0.1, y: 0.2, width: 0.4, height: 0.1 }
                        : {
                              kind: "text",
                              start: 10,
                              end: 15,
                              quote: "08:40",
                              prefix: "Weekdays",
                              suffix: "Platform 2",
                          },
                fingerprint: "0f".repeat(32),
            },
        ];
        document.readings = [
            {
                id: "old_reading",
                anchorId: "old_anchor",
                text: "08:40",
                alternatives: [],
                method: "manual",
                engine: "Fixture",
                createdAt: AT,
            },
        ];
        document.records[0].cells.name = cell("08:40", { anchorIds: ["old_anchor"], readingIds: ["old_reading"] });
        return document;
    }
    function candidate(
        document: RecastDocument,
        id: string,
        prefix: string,
        fingerprint = "0f".repeat(32),
        text = "08:40"
    ) {
        const region = document.anchors[0].region;
        document.anchors.push({
            id,
            sourceId: "replacement",
            sourceHash: "b".repeat(64),
            label: "Replacement",
            region: region.kind === "text" ? { ...region, start: 20, end: 25, prefix } : { ...region },
            fingerprint,
        });
        document.readings.push({
            id: "reading_" + id,
            anchorId: id,
            text,
            alternatives: [],
            method: "manual",
            engine: "Fixture",
            createdAt: AT,
        });
    }
    test("surrounding text distinguishes repeated readings and insufficient context stays ambiguous", () => {
        const document = matching("text");
        candidate(document, "weekend_anchor", "Weekends");
        candidate(document, "weekday_anchor", "Weekdays");
        const before = SafeJSON.stringify(document);
        const preview = previewReconciliation({
            input: document,
            oldSourceId: "source_fixture",
            newSourceId: "replacement",
        });
        expect(preview.items[0].match).toBe("exact");
        expect(preview.items[0].candidates[0].anchorId).toBe("weekday_anchor");
        expect(preview.items[0].candidates[0].method).toBe("context-reading");
        expect(SafeJSON.stringify(document)).toBe(before);
        if (document.anchors[0].region.kind === "text") {
            document.anchors[0].region.prefix = "";
        }
        expect(
            previewReconciliation({ input: document, oldSourceId: "source_fixture", newSourceId: "replacement" })
                .items[0].match
        ).toBe("ambiguous");
    });
    test("image proposals require nearby meaningful fingerprints and never silently relink", () => {
        const document = matching("image");
        candidate(document, "nearby_anchor", "", "0f".repeat(32), "Different literal words");
        const preview = previewReconciliation({
            input: document,
            oldSourceId: "source_fixture",
            newSourceId: "replacement",
        });
        expect(preview.items[0].match).toBe("similar");
        expect(preview.items[0].candidates[0].method).toBe("similar-image");
        expect(document.records[0].cells.name.anchorIds).toEqual(["old_anchor"]);
        candidate(document, "other_anchor", "", "0f".repeat(32), "Another unrelated reading");
        expect(
            previewReconciliation({ input: document, oldSourceId: "source_fixture", newSourceId: "replacement" })
                .items[0].match
        ).toBe("ambiguous");
        document.anchors[0].fingerprint = "0".repeat(64);
        expect(
            previewReconciliation({ input: document, oldSourceId: "source_fixture", newSourceId: "replacement" })
                .items[0].match
        ).toBe("unmatched");
        document.anchors[0].fingerprint = "f0".repeat(32);
        expect(
            previewReconciliation({ input: document, oldSourceId: "source_fixture", newSourceId: "replacement" })
                .items[0].match
        ).toBe("unmatched");
    });
});

describe("atomic bulk correction and opaque original evidence", () => {
    function batch() {
        let document = apply(example(), { kind: "add-source", source: source() });
        document = apply(document, {
            kind: "add-anchor",
            anchor: {
                id: "region_batch",
                sourceId: "source_fixture",
                sourceHash: HASH,
                label: "Departure",
                region: { kind: "rect", page: 0, x: 0.1, y: 0.2, width: 0.4, height: 0.1 },
            },
            reading: {
                id: "reading_batch",
                anchorId: "region_batch",
                text: "08:10",
                alternatives: ["08:40"],
                method: "vision-ocr",
                engine: "Fixture",
                createdAt: AT,
            },
        });
        document = set(document, "name", "08:40", {
            origin: "inferred",
            anchorIds: ["region_batch"],
            readingIds: ["reading_batch"],
            alternatives: ["08:10"],
        });
        document = apply(document, {
            kind: "add-record",
            collectionId: document.collections[0].id,
            id: "record_other",
        });
        document.records[1].cells.name = cell("08:10", {
            origin: "source",
            anchorIds: ["region_batch"],
            readingIds: ["reading_batch"],
        });
        return apply(document, { kind: "accept-records", recordIds: ["record_fixture", "record_other"] });
    }
    test("one bulk operation preserves per-field evidence, original readings and input state", () => {
        const before = batch(),
            original = SafeJSON.stringify(before);
        const corrected = apply(before, {
            kind: "bulk-correct",
            collectionId: before.collections[0].id,
            fieldId: "name",
            recordIds: ["record_fixture", "record_other"],
            value: "08:50",
            note: "User supplied",
            reason: "Same fixture correction",
        });
        expect(corrected.revision).toBe(before.revision + 1);
        expect(corrected.corrections).toHaveLength(before.corrections.length + 2);
        for (const [index, record] of corrected.records.entries()) {
            expect(record.state).toBe("draft");
            expect(record.cells.name.value).toBe("08:50");
            expect(record.cells.name.origin).toBe("user");
            expect(record.cells.name.state).toBe("proposed");
            expect(record.cells.name.anchorIds).toEqual(before.records[index].cells.name.anchorIds);
            expect(record.cells.name.readingIds).toEqual(before.records[index].cells.name.readingIds);
            expect(record.cells.name.alternatives).toEqual(before.records[index].cells.name.alternatives);
            expect(record.cells.value).toEqual(before.records[index].cells.value);
        }
        expect(corrected.readings).toEqual(before.readings);
        expect(SafeJSON.stringify(before)).toBe(original);
        expect(corrected.journal.at(-1)?.recordIds).toEqual(["record_fixture", "record_other"]);
    });
    test("invalid selection cannot partly modify records and unknown stays explicit", () => {
        const document = batch();
        const operation = {
            kind: "bulk-correct",
            collectionId: document.collections[0].id,
            fieldId: "name",
            recordIds: ["record_fixture", "missing"],
            value: "Changed",
            note: "",
            reason: "Fixture",
        } satisfies RecastOperation;
        expect(() => apply(document, operation)).toThrow("Unknown record");
        expect(() => apply(document, { ...operation, recordIds: ["record_fixture", "record_fixture"] })).toThrow(
            "distinct"
        );
        const archived = apply(document, { kind: "archive-records", recordIds: ["record_other"] });
        expect(() => apply(archived, { ...operation, recordIds: ["record_fixture", "record_other"] })).toThrow(
            "active records"
        );
        const cleared = apply(document, { ...operation, recordIds: ["record_fixture", "record_other"], value: null });
        expect(
            cleared.records.every((record) => record.cells.name.value === null && record.cells.name.state === "unknown")
        ).toBe(true);
        expect(() => apply(cleared, { kind: "accept-records", recordIds: ["record_fixture"] })).toThrow();
        expect(document.records[0].cells.name.value).toBe("08:40");
    });
    test("bulk values obey field types before any correction is committed", () => {
        const document = batch();
        document.collections[0].fields[0].type = "number";
        const operation = {
            kind: "bulk-correct",
            collectionId: document.collections[0].id,
            fieldId: "name",
            recordIds: ["record_fixture", "record_other"],
            value: "wrong",
            note: "",
            reason: "Fixture",
        } satisfies RecastOperation;
        expect(() => apply(document, operation)).toThrow("finite number");
        const fixed = apply(document, { ...operation, value: 42 });
        expect(fixed.records.every((record) => record.cells.name.value === 42)).toBe(true);
        expect(document.records[0].cells.name.value).toBe("08:40");
    });
    test("an opaque original can accompany a manual value but cannot justify an inferred guess", () => {
        let document = apply(example(), {
            kind: "add-source",
            source: {
                ...source(),
                kind: "unsupported",
                pageCount: undefined,
                pages: [],
                error: "Unreadable invented source",
            },
        });
        document = apply(document, {
            kind: "add-anchor",
            anchor: {
                id: "opaque_original",
                sourceId: "source_fixture",
                sourceHash: HASH,
                label: "Unreadable original",
                region: { kind: "whole" },
            },
        });
        document = set(document, "name", "User supplied observation", { anchorIds: ["opaque_original"] });
        expect(() => apply(document, { kind: "accept-records", recordIds: ["record_fixture"] })).not.toThrow();
        document = set(document, "name", "Unsupported guess", { origin: "inferred", anchorIds: ["opaque_original"] });
        expect(() => apply(document, { kind: "accept-records", recordIds: ["record_fixture"] })).toThrow(
            "readable source region"
        );
    });
});

describe("source-local correction examples", () => {
    function fixture() {
        let document = apply(example(), { kind: "add-source", source: source() });
        const region = { kind: "rect", page: 0, x: 0.1, y: 0.2, width: 0.4, height: 0.1 } as const;
        for (const suffix of ["old", "new"]) {
            document = apply(document, {
                kind: "add-anchor",
                anchor: {
                    id: "anchor_" + suffix,
                    sourceId: "source_fixture",
                    sourceHash: HASH,
                    label: "Departure",
                    region,
                },
                reading: {
                    id: "reading_" + suffix,
                    anchorId: "anchor_" + suffix,
                    text: "08:10",
                    alternatives: ["08:40"],
                    method: "vision-ocr",
                    engine: "Fixture",
                    createdAt: AT,
                },
            });
        }
        document = set(document, "name", "08:10", {
            origin: "source",
            anchorIds: ["anchor_old"],
            readingIds: ["reading_old"],
        });
        document = set(document, "name", "08:40", {
            origin: "user",
            anchorIds: ["anchor_old"],
            readingIds: ["reading_old"],
        });
        document = apply(document, { kind: "add-record", collectionId: document.collections[0].id, id: "record_next" });
        document.records[1].cells.name = cell("08:10", {
            state: "proposed",
            origin: "source",
            anchorIds: ["anchor_new"],
            readingIds: ["reading_new"],
        });
        return readRecastDocument(document);
    }
    test("matching human judgment is a read-only proposal on current evidence, not acceptance", () => {
        const document = fixture(),
            before = SafeJSON.stringify(document);
        const preview = previewCorrectionExamples({ input: document, recordId: "record_next", fieldId: "name" });
        expect(preview.examples).toHaveLength(1);
        expect(preview.examples[0].value).toBe("08:40");
        expect(SafeJSON.stringify(document)).toBe(before);
        const proposed = apply(document, {
            kind: "reuse-correction",
            recordId: "record_next",
            fieldId: "name",
            correctionId: preview.examples[0].correctionId,
            reason: "Reviewed local example",
        });
        expect(proposed.records[1].cells.name.value).toBe("08:40");
        expect(proposed.records[1].cells.name.origin).toBe("inferred");
        expect(proposed.records[1].cells.name.state).toBe("proposed");
        expect(proposed.records[1].state).toBe("draft");
        expect(proposed.records[1].cells.name.anchorIds).toEqual(["anchor_new"]);
        expect(proposed.records[1].cells.name.readingIds).toEqual(["reading_new"]);
        expect(proposed.readings).toEqual(document.readings);
        expect(() =>
            renderRecastCollection({
                input: proposed,
                collectionId: proposed.collections[0].id,
                format: "csv",
                recordIds: ["record_next"],
            })
        ).toThrow();
    });
    test("different frozen content, distant regions or a changed field type refuse reuse", () => {
        const original = fixture();
        for (const mutate of [
            (document: RecastDocument) => {
                document.anchors[1].region = { kind: "rect", page: 0, x: 0.1, y: 0.7, width: 0.4, height: 0.1 };
            },
            (document: RecastDocument) => {
                document.readings[1].text = "08:20";
            },
            (document: RecastDocument) => {
                document.sources.push({
                    ...source(),
                    id: "unrelated",
                    contentHash: "c".repeat(64),
                    assetName: "c".repeat(64) + ".png",
                });
                document.anchors[1].sourceId = "unrelated";
                document.anchors[1].sourceHash = "c".repeat(64);
            },
        ]) {
            const document = structuredClone(original);
            mutate(document);
            expect(
                previewCorrectionExamples({ input: document, recordId: "record_next", fieldId: "name" }).examples
            ).toEqual([]);
            expect(() =>
                apply(document, {
                    kind: "reuse-correction",
                    recordId: "record_next",
                    fieldId: "name",
                    correctionId: original.corrections.at(-1)!.id,
                    reason: "Unrelated",
                })
            ).toThrow("no longer matches");
        }
        const typed = structuredClone(original);
        typed.collections[0].fields[0].type = "number";
        expect(previewCorrectionExamples({ input: typed, recordId: "record_next", fieldId: "name" }).examples).toEqual(
            []
        );
    });
    test("all evidence behind a combined human correction must still be represented", () => {
        const document = fixture();
        document.corrections.at(-1)!.after.anchorIds.push("anchor_new");
        document.corrections.at(-1)!.after.readingIds.push("reading_new");
        document.anchors[1].region = { kind: "rect", page: 0, x: 0.1, y: 0.7, width: 0.4, height: 0.1 };
        expect(
            previewCorrectionExamples({ input: document, recordId: "record_next", fieldId: "name" }).examples
        ).toEqual([]);
    });
    test("large literal excerpts are bounded without splitting Unicode or changing saved text", () => {
        const document = fixture();
        const literal = "😀".repeat(2000);
        document.readings.forEach((reading) => {
            reading.text = literal;
        });
        const preview = previewCorrectionExamples({ input: document, recordId: "record_next", fieldId: "name" });
        expect(preview.examples).toHaveLength(1);
        expect(Array.from(preview.examples[0].currentReadings[0])).toHaveLength(501);
        expect(preview.examples[0].currentReadings[0]).toEndWith("…");
        expect(document.readings[1].text).toBe(literal);
    });
});

describe("Published Recast ambiguity fixture", () => {
    test("preserves source alternatives and requires a reviewed time zone for deterministic destinations", async () => {
        const fixturePath = new URL("../fixtures/ambiguous-journey.recast", import.meta.url).pathname;
        const { document, packagePath } = await readRecastInput(fixturePath);
        await verifyRecastAssets({ document, packagePath: packagePath! });
        const collectionId = "journeys";
        expect(() => renderRecastCollection({ input: document, collectionId, format: "ics", at: AT })).toThrow(
            "required"
        );
        const operations = recastOperationSchema
            .array()
            .parse(SafeJSON.parse(await Bun.file(new URL("../fixtures/review-journey.json", import.meta.url)).text()));
        const reviewed = operations.reduce(
            (input, operation) => applyRecastOperation({ input, expectedRevision: input.revision, operation, at: AT }),
            document
        );
        expect(reviewed.readings).toEqual(document.readings);
        expect(reviewed.sources).toEqual(document.sources);
        expect(reviewed.records[0].cells.start.value).toBe("2026-10-06T08:40");
        expect(reviewed.records[0].cells.start.alternatives).toEqual(["2026-10-06T08:10", "2026-10-06T08:40"]);
        const ics = renderRecastCollection({ input: reviewed, collectionId, format: "ics", at: AT });
        expect(ics.text).toContain("DTSTART:20261006T064000Z\r\n");
        expect(renderRecastCollection({ input: reviewed, collectionId, format: "ics", at: AT }).text).toBe(ics.text);
        const csv = renderRecastCollection({ input: reviewed, collectionId, format: "csv", at: AT });
        expect(csv.text).toContain("2026-10-06T08:40");
        expect(SafeJSON.parse(csv.evidence)).toMatchObject({
            collections: [{ id: "journeys", kind: "calendar", fields: document.collections[0].fields }],
            records: [
                {
                    collectionId: "journeys",
                    fields: { timezone: { value: "Europe/Prague", origin: "user", evidence: [] } },
                },
            ],
        });
        await verifyRecastAssets({ document: reviewed, packagePath: packagePath! });
    });
});

describe("Distinct Recast source byte budget", () => {
    test("counts shared frozen assets once and rejects conflicting metadata or excessive distinct snapshots", () => {
        const document = newRecastDocument();
        const bytes = 100 * 1024 * 1024;
        const original = { ...source(), kind: "unsupported" as const, bytes };
        document.sources = Array.from({ length: 7 }, (_, index) => ({ ...original, id: `source_${index}` }));
        expect(readRecastDocument(document).sources).toHaveLength(7);
        const conflicting = structuredClone(document);
        conflicting.sources[1].bytes--;
        expect(() => readRecastDocument(conflicting)).toThrow("same byte size");
        document.sources = Array.from({ length: 6 }, (_, index) => {
            const hash = index.toString(16).repeat(64);
            return { ...original, id: `source_${index}`, contentHash: hash, assetName: `${hash}.bin` };
        });
        expect(() => readRecastDocument(document)).toThrow("512 MiB");
    });
});

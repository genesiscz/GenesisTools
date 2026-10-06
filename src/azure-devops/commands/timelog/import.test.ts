import { describe, expect, test } from "bun:test";
import type { TimeLogImportFile } from "@app/azure-devops/types";
import { SafeJSON } from "@genesiscz/utils/json";
import { buildDryRunPreview } from "./import";

describe("timelog import dry-run preview", () => {
    test("preserves the input envelope and leaves the source object byte-equivalent", () => {
        const input: TimeLogImportFile & { metadata: string } = {
            metadata: "must survive",
            entries: [
                {
                    workItemId: 123,
                    hours: 1,
                    timeType: "Development",
                    date: "2026-10-01",
                    comment: "Synthetic fixture",
                },
            ],
        };
        const before = SafeJSON.stringify(input);

        const preview = buildDryRunPreview(input, new Map([[123, "Synthetic title"]]));

        expect(SafeJSON.stringify(input)).toBe(before);
        expect(preview.metadata).toBe("must survive");
        expect(preview.entries[0].workItemTitle).toBe("Synthetic title");
        expect(Array.isArray(preview.entries)).toBe(true);
    });

    test("keeps an already normalized entry unchanged", () => {
        const input = {
            entries: [
                {
                    workItemId: 123,
                    workItemTitle: "Synthetic title",
                    minutes: 30,
                    timeType: "Development",
                    date: "2026-10-01",
                },
            ],
        };

        expect(buildDryRunPreview(input, new Map()).entries).toEqual(input.entries);
    });
});

import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { quotesFor, quoteTranscription } from "@genesiscz/utils/ai/catalog/speech";

import { readMediaCache, writeMediaCache } from "./media-cache.ts";
import { formatUsd, orderQuotes, runLabel } from "./price.ts";

describe("quote table", () => {
    it("lists a ready provider before a cheaper one that is not configured", () => {
        const ordered = orderQuotes(
            [quoteTranscription("xai", 60), quoteTranscription("local-hf", 60), quoteTranscription("openai", 60)],
            new Set(["openai"])
        );

        expect(ordered.map((quote) => quote.provider)).toEqual(["openai", "local-hf", "xai"]);
    });

    it("marks the named Deepgram model and not the provider default", () => {
        const rows = quotesFor(3600, { provider: "deepgram", model: "nova-2-finance" });
        const finance = rows.find((row) => row.model === "nova-2-finance");

        expect(finance?.usdPerHour).toBeCloseTo(7.167e-5 * 3600, 6);
        expect(runLabel(finance ?? rows[0], { provider: "deepgram", model: "nova-2-finance" })).toBe("yes");
        expect(runLabel(quoteTranscription("deepgram", 3600), { provider: "deepgram", model: "nova-2-finance" })).toBe(
            ""
        );
    });

    it("marks the batch default, not the stream row, when no model is passed", () => {
        const batch = quoteTranscription("xai", 60);
        const stream = quotesFor(60).find((row) => row.provider === "xai" && row.mode === "stream");

        expect(runLabel(batch, { provider: "xai" })).toBe("yes");
        expect(stream ? runLabel(stream, { provider: "xai" }) : "missing").toBe("");
        expect(runLabel(batch, {})).toBe("default");
    });

    it("formats sub-cent amounts without trailing zeros", () => {
        expect(formatUsd(0)).toBe("$0");
        expect(formatUsd(null)).toBe("—");
        expect(formatUsd(0.063388888)).toBe("$0.0634");
        expect(formatUsd(0.1)).toBe("$0.1");
    });
});

describe("media cache", () => {
    it("returns the converted file within the hour and drops it after", async () => {
        const dir = await mkdtemp(join(tmpdir(), "transcribe-cache-"));

        try {
            const source = join(dir, "in.mp3");
            await Bun.write(source, "audio");
            const now = 1_700_000_000_000;
            const stored = await writeMediaCache(dir, "x:2102050467505430555", source, now);

            expect(await Bun.file(stored).text()).toBe("audio");
            expect(await readMediaCache(dir, "x:2102050467505430555", now + 60 * 60 * 1000 - 1)).toBe(stored);
            expect(await readMediaCache(dir, "x:2102050467505430555", now + 60 * 60 * 1000)).toBeNull();
            expect(await Bun.file(stored).exists()).toBe(false);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});

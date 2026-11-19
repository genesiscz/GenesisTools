/**
 * Measures the sound the Meetings recorder kept for one meeting. Reads only: it plays nothing, records nothing and
 * writes nothing (run it on a copy or an isolated store with GENESIS_TOOLS_HOME when in doubt).
 *
 *   bun scripts/benchmarks/meetings/sound-probe.ts <meeting> [--loud-db -35] [--json]
 *
 * It prints three tables:
 *   1. gaps: per recorder source, each piece's second 0 (`zeroAt`, else `at`), its length, and the gap to the end of
 *      the piece before it. A gap above 100 ms is sound that no file holds.
 *   2. mic level: per microphone piece, the microphone's median level while the call is loud (the recorder's system
 *      track that overlaps it in time, else the source's call channel, at or above --loud-db), and how closely the
 *      microphone's level follows the call's (a correlation of the two 100 ms level curves on their shared seconds).
 *      Loudness alone can be local speech or noise: the microphone counts as raw (no echo cancelling) only when it is
 *      above -45 dB while the call is loud AND its level follows the call's.
 *   3. clock: per piece, the stamp, the second 0 matched against the source's sound, the offset and whether the peak
 *      was clear. Needs the source's own recording; without it the table is empty.
 */

import { join } from "node:path";
import { OpenedMeeting } from "@app/meetings/lib/opened-meeting";
import {
    type AudioRow,
    audioRowZeroMs,
    measureSoundClock,
    readSoundInputs,
    type SoundInputs,
} from "@app/meetings/lib/sound";
import { toFloat32AudioWindow } from "@genesiscz/utils/audio/converter";
import { out } from "@genesiscz/utils/logger";
import { MeetingStore } from "@genesiscz/utils/meetings/record";
import { formatTable } from "@genesiscz/utils/table";
import { Command } from "commander";

/** The decode rate: the level needs no more. */
const RATE = 16_000;
/** One level value per 100 ms. */
const FRAME = RATE / 10;
/** A gap above this is sound that no file holds (the spec's target). */
const GAP_LIMIT_MS = 100;
/** A microphone this loud while the call is loud may hear the call… */
const RAW_MIC_DB = -45;
/** …and it does when its level curve follows the call's at least this closely (Pearson r of the dB curves). */
const RAW_MIC_MATCH = 0.4;

interface GapRow {
    source: string;
    file: string;
    zero: string;
    durationSec: number;
    gapMs?: number;
    lostMs: number;
    kept: string;
}

interface MicRow {
    file: string;
    reference: "recorder-system" | "source-call";
    loudFrames: number;
    micDb?: number;
    /** How closely the microphone's level follows the call's: 1 is the same curve, 0 is unrelated. */
    callMatch?: number;
}

/** The level in dBFS of each 100 ms frame. */
function levels(samples: Float32Array): number[] {
    const out: number[] = [];

    for (let start = 0; start + FRAME <= samples.length; start += FRAME) {
        let sum = 0;

        for (let index = start; index < start + FRAME; index++) {
            const value = samples[index] ?? 0;
            sum += value * value;
        }

        out.push(10 * Math.log10(sum / FRAME + 1e-12));
    }

    return out;
}

/** Pearson correlation of two equally long curves; undefined when either is flat or too short. */
function correlation(a: readonly number[], b: readonly number[]): number | undefined {
    const length = Math.min(a.length, b.length);

    if (length < 2) {
        return undefined;
    }

    let meanA = 0;
    let meanB = 0;

    for (let index = 0; index < length; index++) {
        meanA += a[index] ?? 0;
        meanB += b[index] ?? 0;
    }

    meanA /= length;
    meanB /= length;
    let cross = 0;
    let spreadA = 0;
    let spreadB = 0;

    for (let index = 0; index < length; index++) {
        const da = (a[index] ?? 0) - meanA;
        const db = (b[index] ?? 0) - meanB;
        cross += da * db;
        spreadA += da * da;
        spreadB += db * db;
    }

    return spreadA > 0 && spreadB > 0 ? cross / Math.sqrt(spreadA * spreadB) : undefined;
}

function median(values: number[]): number | undefined {
    if (values.length === 0) {
        return undefined;
    }

    const sorted = values.toSorted((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
}

/** The time of day with milliseconds; the shared `localTime` gives a date to the minute. */
function clockWithMs(ms: number): string {
    return new Date(ms).toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
        fractionalSecondDigits: 3,
    });
}

function gapRows(rows: readonly AudioRow[]): GapRow[] {
    const result: GapRow[] = [];

    for (const source of ["mic", "system"] as const) {
        const pieces = rows
            .filter((row) => row.source === source)
            .toSorted((a, b) => audioRowZeroMs(a) - audioRowZeroMs(b));
        let previousEnd: number | undefined;

        for (const row of pieces) {
            const zero = audioRowZeroMs(row);
            result.push({
                source,
                file: row.file,
                zero: `${clockWithMs(zero)}${row.zeroAt ? "" : " (at)"}`,
                durationSec: row.durationMs / 1000,
                lostMs: (row.lostSpans ?? []).reduce((sum, [from, to]) => sum + to - from, 0),
                ...(previousEnd !== undefined ? { gapMs: Math.round(zero - previousEnd) } : {}),
                kept: row.kept ?? "normal",
            });
            // A short piece inside a longer one must not move the covered end back.
            previousEnd = Math.max(previousEnd ?? zero, zero + row.durationMs);
        }
    }

    return result;
}

async function micRows(inputs: SoundInputs, loudDb: number): Promise<MicRow[]> {
    const result: MicRow[] = [];
    const mics = inputs.rows.filter((row) => row.source === "mic" && row.durationMs > 0);

    for (const mic of mics) {
        const micZero = audioRowZeroMs(mic);
        const micEnd = micZero + Math.min(mic.durationMs, 60_000);
        // Each source's track starts on its own first sample, so the system piece of the same seconds is the one
        // that overlaps the microphone's time the most, not one with the same stamp.
        const system = inputs.rows
            .filter((row) => row.source === "system" && row.durationMs > 0)
            .map((row) => {
                const zero = audioRowZeroMs(row);
                return { row, zero, overlapMs: Math.min(micEnd, zero + row.durationMs) - Math.max(micZero, zero) };
            })
            .filter((one) => one.overlapMs > 0)
            .toSorted((a, b) => b.overlapMs - a.overlapMs)[0];
        // Both curves cover the same wall-clock seconds: `from`/`to` are ms on the wall clock.
        let window: { from: number; to: number; reference: (fromSec: number, toSec: number) => Promise<Float32Array> };
        let kind: MicRow["reference"] = "recorder-system";

        if (system) {
            window = {
                from: Math.max(micZero, system.zero),
                to: Math.min(micEnd, system.zero + system.row.durationMs),
                reference: (fromSec, toSec) =>
                    toFloat32AudioWindow(join(inputs.folder, system.row.file), {
                        fromSec: fromSec - (system.zero - micZero) / 1000,
                        toSec: toSec - (system.zero - micZero) / 1000,
                    }),
            };
        } else if (inputs.source) {
            const source = inputs.source;
            kind = "source-call";
            window = {
                from: Math.max(micZero, inputs.timelineZeroMs),
                to: Math.min(micEnd, inputs.timelineZeroMs + source.durationSec * 1000),
                reference: (fromSec, toSec) =>
                    toFloat32AudioWindow(source.path, {
                        fromSec: fromSec + (micZero - inputs.timelineZeroMs) / 1000,
                        toSec: toSec + (micZero - inputs.timelineZeroMs) / 1000,
                        channel: source.layout === "right-mic" ? 0 : 1,
                    }),
            };
        } else {
            continue;
        }

        if (window.to - window.from < 1000) {
            continue;
        }

        // Seconds of the microphone file; the reference reader maps them to its own file.
        const fromSec = (window.from - micZero) / 1000;
        const toSec = (window.to - micZero) / 1000;
        const [micSamples, reference] = await Promise.all([
            toFloat32AudioWindow(join(inputs.folder, mic.file), { fromSec, toSec }),
            window.reference(fromSec, toSec),
        ]);
        const micLevels = levels(micSamples);
        const callLevels = levels(reference);
        const loud = micLevels.filter((_level, index) => (callLevels[index] ?? -Infinity) >= loudDb);
        const micDb = median(loud);
        const callMatch = correlation(micLevels, callLevels);
        result.push({
            file: mic.file,
            reference: kind,
            loudFrames: loud.length,
            ...(micDb !== undefined ? { micDb: Math.round(micDb * 10) / 10 } : {}),
            ...(callMatch !== undefined ? { callMatch: Math.round(callMatch * 100) / 100 } : {}),
        });
    }

    return result;
}

async function main(): Promise<void> {
    const program = new Command()
        .name("sound-probe")
        .description("Measure the sound the Meetings recorder kept for one meeting. Plays, records and writes nothing.")
        .argument("<meeting>", "the meeting id (or a reference `tools meetings show` takes)")
        .option("--loud-db <db>", "the call counts as loud at or above this level (dBFS)", "-35")
        .option("--json", "print the measurements as JSON")
        .parse();
    const [ref] = program.args;
    const opts = program.opts<{ loudDb: string; json?: boolean }>();
    const loudDb = Number(opts.loudDb);

    if (!ref || !Number.isFinite(loudDb)) {
        throw new Error("Usage: sound-probe.ts <meeting> [--loud-db -35] [--json]");
    }

    const store = new MeetingStore();
    const record = store.resolve(ref);

    if (!record) {
        throw new Error(`No meeting matches ${ref} in ${store.root}.`);
    }

    const inputs = await readSoundInputs(OpenedMeeting.of(store, record));
    const gaps = gapRows(inputs.rows);
    const mic = await micRows(inputs, loudDb);
    const measured = await measureSoundClock(inputs, { maxPieces: Number.POSITIVE_INFINITY });
    const clock = (measured?.pieces ?? []).map((piece) => ({
        source: piece.source,
        file: piece.file,
        stampSec: Math.round(piece.stampSec * 1000) / 1000,
        zeroSec: Math.round(piece.zeroSec * 1000) / 1000,
        offsetMs: Math.round((piece.zeroSec - piece.stampSec) * 1000),
        clear: piece.clear,
    }));
    const gapSummary = (["mic", "system"] as const).map((source) => {
        const values = gaps
            .filter((row) => row.source === source && row.gapMs !== undefined)
            .map((row) => row.gapMs ?? 0);
        return {
            source,
            pieces: gaps.filter((row) => row.source === source).length,
            maxGapMs: values.length > 0 ? Math.max(...values) : undefined,
            medianGapMs: median(values),
            overLimit: values.filter((value) => value > GAP_LIMIT_MS).length,
        };
    });
    const micDb = median(mic.flatMap((row) => (row.micDb !== undefined ? [row.micDb] : [])));
    const callMatch = median(mic.flatMap((row) => (row.callMatch !== undefined ? [row.callMatch] : [])));
    const summary = {
        meeting: record.id,
        gaps: gapSummary,
        micDb,
        callMatch,
        micRaw: micDb === undefined ? undefined : micDb > RAW_MIC_DB && (callMatch ?? 0) >= RAW_MIC_MATCH,
        clock: measured?.clock,
    };

    if (opts.json) {
        out.result({ summary, gaps, mic, clock });
        return;
    }

    out.println(
        formatTable(
            gaps.map((row) => [
                row.source,
                row.file,
                row.zero,
                row.durationSec.toFixed(3),
                row.gapMs?.toString() ?? "",
                row.lostMs.toString(),
                row.kept,
            ]),
            ["source", "file", "second 0 (local)", "length s", "gap ms", "lost ms", "kept"],
            { alignRight: [3, 4, 5] }
        )
    );
    out.println(
        formatTable(
            gapSummary.map((row) => [
                row.source,
                String(row.pieces),
                row.maxGapMs?.toString() ?? "",
                row.medianGapMs?.toString() ?? "",
                `${row.overLimit} over ${GAP_LIMIT_MS} ms`,
            ]),
            ["source", "pieces", "max gap ms", "median gap ms", "gaps"],
            { alignRight: [1, 2, 3] }
        )
    );
    out.println(
        formatTable(
            mic.map((row) => [
                row.file,
                row.reference,
                String(row.loudFrames),
                row.micDb?.toString() ?? "(call never loud)",
                row.callMatch?.toString() ?? "",
            ]),
            ["mic piece", "loud call from", "loud 100 ms frames", "mic dB while call loud", "follows call (r)"],
            { alignRight: [2, 3, 4] }
        )
    );
    out.println(
        micDb === undefined
            ? "mic level: no microphone piece with a loud call"
            : `mic level: median ${micDb} dB while the call is loud, follows the call r=${callMatch ?? "?"}; ${summary.micRaw ? "the call is on the microphone track (raw)" : micDb > RAW_MIC_DB ? `loud, but its level does not follow the call (r below ${RAW_MIC_MATCH}): local speech or noise, not proven raw` : `below ${RAW_MIC_DB} dB (processed, or the call was quiet)`}`
    );
    out.println(
        clock.length === 0
            ? "clock: no source sound for this meeting, so the clock cannot be measured"
            : formatTable(
                  clock.map((row) => [
                      row.source,
                      row.file,
                      String(row.stampSec),
                      String(row.zeroSec),
                      String(row.offsetMs),
                      row.clear ? "yes" : "no",
                  ]),
                  ["source", "file", "stamp s", "measured s", "offset ms", "clear"],
                  { alignRight: [2, 3, 4] }
              )
    );
}

main().catch((error) => {
    out.log.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});

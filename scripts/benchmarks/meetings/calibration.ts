/**
 * On a meeting copy with collected channel energy, compare Wispr's recording clock with the saved audio.
 * Positive offset means looking later in the audio. The sweep uses the original calibration's mean RMS share
 * and 1.5 s minimum duration. Both the numerator and denominator are measured in the production cache's units.
 */
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { OpenedMeeting } from "@app/meetings/lib/opened-meeting";
import { out } from "@genesiscz/utils/logger";
import {
    type ChannelCalibration,
    calibrateChannels,
    channelEnergy,
    ENERGY_BLOCKS_PER_SEC,
    energyShare,
    median,
    readCachedChannelEnergy,
} from "@genesiscz/utils/meetings/energy";
import { MEETING_FILE, MeetingStore } from "@genesiscz/utils/meetings/record";
import type { EvidenceSegment } from "@genesiscz/utils/transcribe/evidence";

const store = new MeetingStore();
const ref = process.argv[2];
if (!ref) {
    throw new Error("Usage: calibration.ts <meeting-copy> | --census <base-checkout>");
}

if (ref === "--census") {
    const base = process.argv[3];
    if (!base) {
        throw new Error("Supply the checkout containing the base calibrateChannels implementation.");
    }
    await census(base);
} else {
    await sweep(ref);
}

async function census(baseCheckout: string): Promise<void> {
    const baseline: { calibrateChannels: typeof calibrateChannels } = await import(
        join(resolve(baseCheckout), "src/utils/meetings/energy.ts")
    );
    const scratch = mkdtempSync(join(tmpdir(), "meetings-census-"));
    const records = [];
    const changes = [];
    const failures = [];
    for (const entry of readdirSync(store.root, { withFileTypes: true })) {
        const id = entry.name;
        if (!entry.isDirectory() || !existsSync(join(store.root, id, MEETING_FILE))) {
            continue;
        }
        let base: ChannelCalibration | undefined, head: ChannelCalibration | undefined;
        let stored: ChannelCalibration | undefined;
        let unavailable: string | undefined;
        try {
            const record = store.read(id);
            if (!record) {
                throw new Error("Record failed schema validation");
            }
            stored = record.evidence?.channels;
            const opened = OpenedMeeting.of(store, record);
            const evidence = opened.sourceRef ? await opened.sourceEvidence() : null;
            if (evidence?.audioPath) {
                // Only the scratch cache is writable. Both revisions receive the same samples and tagged spans.
                const energy =
                    readCachedChannelEnergy(join(store.folder(id), "evidence", "energy.bin"), evidence.audioPath) ??
                    (await channelEnergy(evidence.audioPath, join(scratch, Bun.hash(evidence.audioPath).toString())));
                if (!energy) {
                    throw new Error("Could not read channel energy");
                }
                base = baseline.calibrateChannels(energy, evidence.segments);
                head = calibrateChannels(energy, evidence.segments, {
                    minSeparation: (await opened.config()).global.speakerLabels.channels.minSeparation,
                    sourceLayout: (await opened.linked()).source.sourceLayout,
                });
            } else {
                unavailable = "no source audio";
            }
        } catch (error) {
            unavailable = error instanceof Error ? error.message : String(error);
            failures.push({ id, reason: unavailable });
        }
        const row = { id, stored: stored?.layout ?? null, base: base ?? null, head: head ?? null, unavailable };
        records.push(row);
        if (head && (base?.layout !== head.layout || (stored && stored.layout !== head.layout))) {
            changes.push(id);
        }
        if ([base, stored].some((before) => before && before.layout !== "unknown" && before.layout !== head?.layout)) {
            failures.push({ id, reason: "formerly known layout changed or could not be checked" });
        }
    }
    out.result({ records, changes, failures });
    if (!records.length || failures.length) {
        process.exitCode = 1;
    }
}

async function sweep(ref: string): Promise<void> {
    const record = store.resolve(ref);
    if (!record) {
        throw new Error(`Unknown meeting ${ref}`);
    }
    const opened = OpenedMeeting.of(store, record);
    const evidence = await opened.sourceEvidence();
    const cache = join(store.folder(record.id), "evidence", "energy.bin");
    const energy = evidence?.audioPath ? readCachedChannelEnergy(cache, evidence.audioPath) : undefined;
    if (!evidence || !energy) {
        throw new Error("Run meetings acoustic collect on the isolated copy first; there is no current energy cache.");
    }

    const duration = energy.left.length / ENERGY_BLOCKS_PER_SEC;
    const valid = evidence.segments.filter((s) => s.endSec > s.startSec);
    const long = valid.filter((s) => s.endSec - s.startSec >= 1.5);
    const overlaps = (s: EvidenceSegment) =>
        valid.some((t) => t.channel !== s.channel && s.startSec < t.endSec && t.startSec < s.endSec);
    const overlap = new Set(long.filter(overlaps));

    function measure(segments: EvidenceSegment[], offsetSec: number) {
        const shares: Record<EvidenceSegment["channel"], number[]> = { mic: [], system: [] };
        for (const s of segments) {
            const { share } = energyShare(energy!, s.startSec + offsetSec, s.endSec + offsetSec);
            if (share !== undefined) {
                shares[s.channel].push(share);
            }
        }
        const micMedian = median(shares.mic);
        const systemMedian = median(shares.system);
        return {
            offsetSec,
            mic: shares.mic.length,
            system: shares.system.length,
            micMedian,
            systemMedian,
            separation: micMedian !== undefined && systemMedian !== undefined ? micMedian - systemMedian : undefined,
        };
    }

    // Keep the same segments at all 601 offsets. Otherwise moving a segment off the end can improve the score.
    const interior = long.filter((s) => s.startSec >= 30 && s.endSec + 30 <= duration);
    const offsets = Array.from({ length: 601 }, (_, i) => measure(interior, (i - 300) / 10));
    const best = offsets
        .filter((r) => r.mic >= 20 && r.system >= 20)
        .sort(
            (a, b) => Math.abs(b.separation!) - Math.abs(a.separation!) || Math.abs(a.offsetSec) - Math.abs(b.offsetSec)
        )[0];
    if (!best) {
        throw new Error("Too few interior tagged segments for an offset comparison.");
    }

    out.result({
        id: record.id,
        duration,
        tags: ["mic", "system"].map((channel) => {
            const tagged = evidence.segments.filter((s) => s.channel === channel);
            return {
                channel,
                total: tagged.length,
                medianDuration: median(tagged.map((s) => s.endSec - s.startSec)),
                outsideAudio: tagged.filter((s) => s.startSec < 0 || s.endSec > duration).length,
                invalidDuration: tagged.filter((s) => s.endSec <= s.startSec).length,
            };
        }),
        original: measure(long, 0),
        shortOnly: measure(
            valid.filter((s) => s.endSec - s.startSec < 1.5),
            0
        ),
        overlapping: measure([...overlap], 0),
        uncontested: measure(
            long.filter((s) => !overlap.has(s)),
            0
        ),
        sweep: {
            firstSec: -30,
            lastSec: 30,
            stepSec: 0.1,
            zero: offsets[300],
            best,
            halves: [
                interior.filter((s) => s.startSec < duration / 2),
                interior.filter((s) => s.startSec >= duration / 2),
            ].map((part) => ({ zero: measure(part, 0), atBest: measure(part, best.offsetSec) })),
        },
        current: (await opened.energy()).calibration,
    });
}

import { compareImagePixels } from "@genesiscz/utils/image/difference";
import type { DecodedRgba } from "@genesiscz/utils/image/raster";

export interface FrameDifferenceDecision {
    id: string;
    kept: boolean;
    differencePct: number | null;
    comparedToId: string | null;
}

/** One instance per preparation revision. A skipped frame never becomes the comparison baseline. */
export class FrameDifferenceGuard {
    private baseline: { id: string; image: DecodedRgba } | undefined;
    private readonly minimumDifferencePct: number;

    constructor({ minimumDifferencePct }: { minimumDifferencePct: number }) {
        if (!Number.isFinite(minimumDifferencePct) || minimumDifferencePct < 0 || minimumDifferencePct > 100) {
            throw new Error("Minimum frame difference must be between 0 and 100 percent");
        }

        this.minimumDifferencePct = minimumDifferencePct;
    }

    consider({ id, image }: { id: string; image: DecodedRgba }): FrameDifferenceDecision {
        const baseline = this.baseline;
        const difference = compareImagePixels({ a: baseline?.image ?? image, b: image });
        const kept = !baseline || difference.differencePct >= this.minimumDifferencePct;

        if (kept) {
            // Decoders may reuse their output buffer for the next candidate.
            this.baseline = { id, image: { ...image, data: new Uint8ClampedArray(image.data) } };
        }

        return {
            id,
            kept,
            differencePct: baseline ? difference.differencePct : null,
            comparedToId: baseline?.id ?? null,
        };
    }
}

export function frameDifferenceSummary({
    decisions,
    framesPerImage,
}: {
    decisions: readonly FrameDifferenceDecision[];
    framesPerImage: number;
}) {
    if (![1, 4, 8, 16, 32].includes(framesPerImage)) {
        throw new Error("Frames per image must be 1, 4, 8, 16, or 32");
    }

    const kept = decisions.reduce((count, decision) => count + Number(decision.kept), 0);
    return {
        candidates: decisions.length,
        kept,
        skipped: decisions.length - kept,
        images: Math.ceil(kept / framesPerImage),
        lastImageFrames: kept === 0 ? 0 : ((kept - 1) % framesPerImage) + 1,
    };
}

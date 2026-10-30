import { decodeImageRgba, decodeImageRgbaScaled, encodeRgbaToPng, renderAnnotationPlan } from "@genesiscz/utils/image";
import { compareImagePixels } from "@genesiscz/utils/image/difference";
import { logger, out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import pc from "picocolors";
import { DEFAULT_REGION_OPTIONS, type DiffRegion, findDiffRegions, regionAnnotations } from "../lib/diff-regions";

interface CompareOptions {
    threshold: string;
    maxMismatch?: string;
    diffOut?: string;
    resizeToMatch?: boolean;
    regions?: boolean;
    mergeDistance: string;
    minArea: string;
    annotateOut?: string;
    json?: boolean;
}

function nonNegativeNumber(value: string, flag: string): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
        logger.error(`${flag} must be a number of pixels, 0 or more (got "${value}")`);
        process.exit(2);
    }

    return parsed;
}

export function registerCompareScreenshotCommand(program: Command): void {
    program
        .command("compare-screenshot <a> <b>")
        .description(
            "Pixelmatch two images: mismatch count/percentage + similarity score, optional diff PNG.\nExit 0 = within --max-mismatch (or no gate), 1 = over it, 2 = unusable inputs (e.g. dimension mismatch without --resize-to-match)."
        )
        .option(
            "--threshold <0..1>",
            "per-pixel color-distance sensitivity (lower = stricter, AA-tolerant ~0.1)",
            "0.1"
        )
        .option("--max-mismatch <pct>", "fail (exit 1) when mismatched pixels exceed this percentage, e.g. 0.5")
        .option("--diff-out <path>", "write the highlighted diff PNG here")
        .option("--resize-to-match", "scale image B to A's dimensions instead of erroring on mismatch")
        .option(
            "--regions",
            "also find the changed regions: mismatched pixels (anti-aliasing excluded) clustered into boxes, printed as {x,y,w,h,pixels} in image A's pixels"
        )
        .option(
            "--merge-distance <px>",
            "with --regions: changes at most this far apart join one box",
            String(DEFAULT_REGION_OPTIONS.mergeDistance)
        )
        .option(
            "--min-area <px>",
            "with --regions: drop a box with fewer mismatched pixels (noise)",
            String(DEFAULT_REGION_OPTIONS.minArea)
        )
        .option(
            "--annotate-out <path>",
            "write image B with the region boxes drawn and numbered (implies --regions; the `draw` engine)"
        )
        .option("--json", "machine-readable result JSON on stdout")
        .action(async (aPath: string, bPath: string, opts: CompareOptions) => {
            for (const p of [aPath, bPath]) {
                if (!(await Bun.file(p).exists())) {
                    logger.error(`image not found: ${p}`);
                    process.exit(2);
                }
            }

            const threshold = Number(opts.threshold);
            if (!(threshold >= 0 && threshold <= 1)) {
                logger.error(`--threshold must be between 0 and 1 (got "${opts.threshold}")`);
                process.exit(2);
            }

            let a: Awaited<ReturnType<typeof decodeImageRgba>>;
            let b: Awaited<ReturnType<typeof decodeImageRgba>>;
            try {
                a = await decodeImageRgba(aPath);
                b = await decodeImageRgba(bPath);
            } catch (e) {
                logger.error(`cannot decode image: ${e instanceof Error ? e.message : String(e)}`);
                process.exit(2);
            }

            let resized = false;

            if (a.width !== b.width || a.height !== b.height) {
                if (!opts.resizeToMatch) {
                    logger.error(
                        `dimension mismatch: ${a.width}x${a.height} vs ${b.width}x${b.height} — pass --resize-to-match to scale B onto A`
                    );
                    process.exit(2);
                }

                b = await decodeImageRgbaScaled(bPath, a.width, a.height);
                resized = true;
            }

            const {
                diff,
                mismatchedPixels: mismatched,
                totalPixels: total,
                differencePct: mismatchPct,
                similarity,
            } = compareImagePixels({ a, b, sensitivity: threshold, includeDiff: !!opts.diffOut });

            if (opts.diffOut && diff) {
                await Bun.write(opts.diffOut, encodeRgbaToPng(diff, a.width, a.height));
            }

            let regions: DiffRegion[] | undefined;
            if (opts.regions || opts.annotateOut) {
                regions = findDiffRegions(a, b, {
                    threshold,
                    mergeDistance: nonNegativeNumber(opts.mergeDistance, "--merge-distance"),
                    minArea: nonNegativeNumber(opts.minArea, "--min-area"),
                }).regions;
                logger.debug({ a: aPath, b: bPath, regions: regions.length }, "compare-screenshot regions");
            }

            if (opts.annotateOut && regions) {
                const drawn = await renderAnnotationPlan({
                    input: resized ? encodeRgbaToPng(b.data, b.width, b.height) : bPath,
                    annotations: regionAnnotations(regions),
                });
                await Bun.write(opts.annotateOut, drawn.png);
            }

            const maxMismatch = opts.maxMismatch !== undefined ? Number(opts.maxMismatch) : undefined;
            if (maxMismatch !== undefined && (!Number.isFinite(maxMismatch) || maxMismatch < 0 || maxMismatch > 100)) {
                logger.error(`--max-mismatch must be a percentage between 0 and 100 (got "${opts.maxMismatch}")`);
                process.exit(2);
            }

            const pass = maxMismatch === undefined ? true : mismatchPct <= maxMismatch;

            if (opts.json) {
                out.result({
                    ok: pass,
                    a: aPath,
                    b: bPath,
                    width: a.width,
                    height: a.height,
                    resized: resized || undefined,
                    threshold,
                    mismatchedPixels: mismatched,
                    totalPixels: total,
                    mismatchPct: Number(mismatchPct.toFixed(4)),
                    similarity: Number(similarity.toFixed(6)),
                    maxMismatchPct: maxMismatch,
                    diffOut: opts.diffOut,
                    regions,
                    annotateOut: opts.annotateOut,
                });
            } else {
                const verdict =
                    maxMismatch === undefined
                        ? pc.dim("(no --max-mismatch gate)")
                        : pass
                          ? pc.green(`PASS (<= ${maxMismatch}%)`)
                          : pc.red(`FAIL (> ${maxMismatch}%)`);
                out.println(
                    `${mismatched}/${total} pixels differ — ${mismatchPct.toFixed(3)}% (similarity ${(similarity * 100).toFixed(3)}%, threshold ${threshold}) ${verdict}`
                );

                if (opts.diffOut) {
                    out.println(pc.dim(`diff -> ${opts.diffOut}`));
                }

                if (regions) {
                    out.println(`${regions.length} changed region(s)`);
                    for (const [index, region] of regions.entries()) {
                        out.println(
                            `  ${index + 1}. x=${region.x} y=${region.y} w=${region.w} h=${region.h} (${region.pixels} px)`
                        );
                    }
                }

                if (opts.annotateOut) {
                    out.println(pc.dim(`annotated -> ${opts.annotateOut}`));
                }
            }

            process.exit(pass ? 0 : 1);
        });
}

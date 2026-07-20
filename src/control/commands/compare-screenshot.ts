import { decodeImageRgba, decodeImageRgbaScaled, encodeRgbaToPng } from "@genesiscz/utils/image";
import { logger, out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import pc from "picocolors";
import pixelmatch from "pixelmatch";

interface CompareOptions {
    threshold: string;
    maxMismatch?: string;
    diffOut?: string;
    resizeToMatch?: boolean;
    json?: boolean;
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

            const a = await decodeImageRgba(aPath);
            let b = await decodeImageRgba(bPath);
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

            const diff = opts.diffOut ? new Uint8ClampedArray(a.width * a.height * 4) : undefined;
            const mismatched = pixelmatch(a.data, b.data, diff, a.width, a.height, { threshold });
            const total = a.width * a.height;
            const mismatchPct = (100 * mismatched) / total;
            const similarity = 1 - mismatched / total;

            if (opts.diffOut && diff) {
                await Bun.write(opts.diffOut, encodeRgbaToPng(diff, a.width, a.height));
            }

            const maxMismatch = opts.maxMismatch !== undefined ? Number(opts.maxMismatch) : undefined;
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
            }

            process.exit(pass ? 0 : 1);
        });
}

import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { getDarwinKit } from "./darwinkit";
import type { OcrBlock, OcrLevel, OcrResult } from "./types";

export const OCR_READS = ["frame", "tiles"] as const;
export type OcrRead = (typeof OCR_READS)[number];

export interface OcrOptions {
    /** Side-by-side region reads without language correction. Default: frame. */
    read?: OcrRead;
    /** BCP-47 language codes to use for recognition. Default: ["en-US"] */
    languages?: string[];
    /** "fast" for speed, "accurate" for quality. Default: "accurate" */
    level?: OcrLevel;
    /**
     * An accurate read that finds nothing is read again at the fast level. Default: true. A caller that reads a crop
     * which may hold no text turns it off, so an empty crop costs one read, not two.
     */
    fastFallback?: boolean;
    /** How long one Vision request may take (darwinkit's own deadline, 60 s, when absent); a frame read, not tiles. */
    timeoutMs?: number;
}

/**
 * A `sips` read or crop that has not finished by then is killed. Vision requests carry darwinkit's own request deadline
 * (30 s), so with this every await of an OCR run ends, and a stalled frame cannot hold up a recording's finish.
 */
const SIPS_TIMEOUT_MS = 15_000;

/** Vision accurate OCR returns empty results above ~6k px on one side (macOS 15). */
const MAX_ACCURATE_DIMENSION = 6000;
const TILE_HEIGHT = 5000;

interface ImageDimensions {
    width: number;
    height: number;
}

interface TilePart {
    result: OcrResult;
    top: number;
    tileHeight: number;
}

function isEmptyOcrResult(result: OcrResult): boolean {
    if (result.text.trim().length > 0) {
        return false;
    }

    return result.blocks.length === 0;
}

async function callVisionOcr(
    imagePath: string,
    languages: string[],
    level: OcrLevel,
    timeoutMs?: number
): Promise<OcrResult> {
    return getDarwinKit().vision.ocr(
        {
            path: imagePath,
            languages,
            level,
        },
        timeoutMs ? { timeout: timeoutMs } : undefined
    );
}

async function getImageDimensions(imagePath: string): Promise<ImageDimensions | null> {
    const proc = Bun.spawn(["sips", "-g", "pixelWidth", "-g", "pixelHeight", imagePath], {
        stdout: "pipe",
        stderr: "pipe",
        timeout: SIPS_TIMEOUT_MS,
    });

    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

    if (exitCode !== 0) {
        logger.debug({ imagePath, exitCode, signal: proc.signalCode }, "darwin-ocr: sips could not read the size");
        return null;
    }

    const widthMatch = stdout.match(/pixelWidth:\s*(\d+)/);
    const heightMatch = stdout.match(/pixelHeight:\s*(\d+)/);

    if (!widthMatch || !heightMatch) {
        return null;
    }

    return {
        width: Number(widthMatch[1]),
        height: Number(heightMatch[1]),
    };
}

async function cropImageTile(
    sourcePath: string,
    destPath: string,
    opts: { top: number; height: number; width: number }
): Promise<boolean> {
    const proc = Bun.spawn(
        [
            "sips",
            "-c",
            String(opts.height),
            String(opts.width),
            "--cropOffset",
            String(opts.top),
            "0",
            sourcePath,
            "--out",
            destPath,
        ],
        { stdout: "pipe", stderr: "pipe", timeout: SIPS_TIMEOUT_MS }
    );

    const exitCode = await proc.exited;

    if (exitCode !== 0) {
        logger.debug({ sourcePath, exitCode, signal: proc.signalCode }, "darwin-ocr: sips could not crop a tile");
    }

    return exitCode === 0;
}

function toNormalized(value: number | string): number {
    return typeof value === "number" ? value : Number(value);
}

export function mergeTiledOcrResults(parts: TilePart[], fullHeight: number): OcrResult {
    const blocks: OcrBlock[] = [];
    const textParts: string[] = [];

    for (const { result, top, tileHeight } of parts) {
        if (result.text.trim().length > 0) {
            textParts.push(result.text);
        }

        const tileBottomFromImageBottom = (fullHeight - top - tileHeight) / fullHeight;
        const tileHeightNorm = tileHeight / fullHeight;

        for (const block of result.blocks) {
            const y = toNormalized(block.bounds.y);
            const h = toNormalized(block.bounds.height);

            blocks.push({
                ...block,
                bounds: {
                    ...block.bounds,
                    y: tileBottomFromImageBottom + y * tileHeightNorm,
                    height: h * tileHeightNorm,
                },
            });
        }
    }

    return {
        text: textParts.join("\n"),
        blocks,
    };
}

/** Ultrawide frames need two reads; ordinary landscape and portrait frames need one. */
export function planOcrTiles({ width, height }: ImageDimensions) {
    const count = width / height >= 2 ? 2 : 1;
    return Array.from({ length: count }, (_, index) => {
        const x = Math.max(0, index / count - (index > 0 ? 0.03 : 0));
        const right = Math.min(1, (index + 1) / count + (index < count - 1 ? 0.03 : 0));
        return { x, y: 0, width: right - x, height: 1 };
    });
}

/** Region OCR already answers in full-image, bottom-left coordinates. Never scale those bounds again. */
export function mergeRegionOcrResults(parts: OcrResult[]): OcrResult {
    const blocks: OcrBlock[] = [];
    const fold = (text: string) => text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

    for (const part of parts) {
        for (const block of part.blocks) {
            const duplicate = blocks.findIndex((other) => {
                if (fold(other.text) !== fold(block.text)) {
                    return false;
                }

                const a = other.bounds;
                const b = block.bounds;
                const overlapWidth = Math.max(0, Math.min(+a.x + +a.width, +b.x + +b.width) - Math.max(+a.x, +b.x));
                const overlapHeight = Math.max(0, Math.min(+a.y + +a.height, +b.y + +b.height) - Math.max(+a.y, +b.y));
                const area = Math.min(+a.width * +a.height, +b.width * +b.height);
                return area > 0 && (overlapWidth * overlapHeight) / area > 0.5;
            });

            if (duplicate < 0) {
                blocks.push(block);
            } else if (block.confidence > blocks[duplicate].confidence) {
                blocks[duplicate] = block;
            }
        }
    }

    return { text: blocks.map((block) => block.text).join("\n"), blocks };
}

function needsAccurateTiling(dims: ImageDimensions): boolean {
    return dims.height > MAX_ACCURATE_DIMENSION || dims.width > MAX_ACCURATE_DIMENSION;
}

async function recognizeTextTiled(
    imagePath: string,
    dims: ImageDimensions,
    languages: string[],
    level: OcrLevel
): Promise<OcrResult> {
    const parts: TilePart[] = [];
    const tempPaths: string[] = [];

    try {
        for (let top = 0; top < dims.height; top += TILE_HEIGHT) {
            const tileHeight = Math.min(TILE_HEIGHT, dims.height - top);
            const tempPath = join(tmpdir(), `darwin-ocr-tile-${Date.now()}-${top}.png`);
            tempPaths.push(tempPath);

            const cropped = await cropImageTile(imagePath, tempPath, {
                top,
                height: tileHeight,
                width: dims.width,
            });

            if (!cropped) {
                logger.warn({ imagePath, top, tileHeight }, "darwin-ocr: tile crop failed");
                continue;
            }

            const result = await callVisionOcr(tempPath, languages, level);
            parts.push({ result, top, tileHeight });
        }
    } finally {
        for (const tempPath of tempPaths) {
            if (existsSync(tempPath)) {
                try {
                    unlinkSync(tempPath);
                } catch (err) {
                    logger.debug({ err, tempPath }, "darwin-ocr: failed to remove tile temp file");
                }
            }
        }
    }

    if (parts.length === 0) {
        return { text: "", blocks: [] };
    }

    logger.debug(
        { imagePath, tiles: parts.length, width: dims.width, height: dims.height },
        "darwin-ocr: used vertical tiling for oversized image"
    );

    return mergeTiledOcrResults(parts, dims.height);
}

/**
 * Extract text from an image file using Apple's Vision framework.
 * Coordinates in blocks are normalized (0–1) with bottom-left origin.
 *
 * @param imagePath - Absolute path to the image file (JPEG, PNG, TIFF, HEIC, PDF)
 */
export async function recognizeText(imagePath: string, options: OcrOptions = {}): Promise<OcrResult> {
    const level = options.level ?? "accurate";
    const languages = options.languages ?? ["en-US"];

    const dimensions = level === "accurate" || options.read === "tiles" ? await getImageDimensions(imagePath) : null;

    if (level === "accurate") {
        const dims = dimensions;

        if (dims && needsAccurateTiling(dims)) {
            const tiled = await recognizeTextTiled(imagePath, dims, languages, level);

            if (!isEmptyOcrResult(tiled)) {
                return tiled;
            }

            logger.debug({ imagePath, dims }, "darwin-ocr: tiled accurate empty, falling back to fast");
        }
    }

    if (options.read === "tiles") {
        const dims = dimensions;

        if (dims && !needsAccurateTiling(dims)) {
            const parts: OcrResult[] = [];

            for (const region of planOcrTiles(dims)) {
                parts.push(
                    await getDarwinKit().vision.ocr({
                        path: imagePath,
                        languages,
                        level,
                        region,
                        language_correction: false,
                    })
                );
            }

            return mergeRegionOcrResults(parts);
        }
    }

    const result = await callVisionOcr(imagePath, languages, level, options.timeoutMs);

    if (level === "accurate" && options.fastFallback !== false && isEmptyOcrResult(result)) {
        logger.debug({ imagePath }, "darwin-ocr: accurate empty, falling back to fast");
        return callVisionOcr(imagePath, languages, "fast", options.timeoutMs);
    }

    return result;
}

/**
 * Extract text from an image buffer.
 * Writes the buffer to a temp file, runs OCR, then cleans up.
 *
 * @param buffer    - Raw image bytes
 * @param extension - File extension hint, e.g. "png", "jpg". Default: "png"
 */
export async function recognizeTextFromBuffer(
    buffer: Buffer | Uint8Array,
    extension = "png",
    options: OcrOptions = {}
): Promise<OcrResult> {
    const tempPath = join(tmpdir(), `darwin-ocr-${Date.now()}.${extension}`);
    try {
        writeFileSync(tempPath, buffer);
        return await recognizeText(tempPath, options);
    } finally {
        if (existsSync(tempPath)) {
            try {
                unlinkSync(tempPath);
            } catch (err) {
                logger.debug({ err, tempPath }, "darwin-ocr: failed to remove buffer temp file");
            }
        }
    }
}

/**
 * Extract only the plain text string from an image file (no bounding boxes).
 */
export async function extractText(imagePath: string, options: OcrOptions = {}): Promise<string> {
    const result = await recognizeText(imagePath, options);
    return result.text;
}

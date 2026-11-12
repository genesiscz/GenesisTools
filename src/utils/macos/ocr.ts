import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { createIdleCloser, DarwinKit, getDarwinKit, type IdleCloser, leaseDarwinKit } from "./darwinkit";
import type { OcrBlock, OcrLevel, OcrResult } from "./types";

export const OCR_READS = ["frame", "tiles"] as const;
export type OcrRead = (typeof OCR_READS)[number];

export interface OcrOptions {
    /** A grid of region reads without language correction (`tiles`), or one read of the whole image. Default: frame. */
    read?: OcrRead;
    /** With `read: "tiles"`: the longest side of one tile in image pixels. Default: DEFAULT_OCR_TILE_PX. */
    tilePx?: number;
    /** BCP-47 language codes to use for recognition. Default: ["en-US"] */
    languages?: string[];
    /** "fast" for speed, "accurate" for quality. Default: "accurate" */
    level?: OcrLevel;
    /**
     * An accurate read that finds nothing is read again at the fast level. Default: true. A caller that reads a crop
     * which may hold no text turns it off, so an empty crop costs one read, not two.
     */
    fastFallback?: boolean;
    /** How long each Vision request may take, including each tile (darwinkit's 60 s deadline when absent). */
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

interface OcrClient {
    client: DarwinKit;
    lease: () => () => void;
    closer?: IdleCloser;
}

let recoveredClient: OcrClient | undefined;

function imageReaderFailed(error: unknown): boolean {
    return error instanceof Error && /TextRecognition\.CRImageReaderError error 1\b/.test(error.message);
}

function retireOcrClient(failed: OcrClient): void {
    if (recoveredClient === failed) {
        recoveredClient = undefined;
    }

    failed.closer?.closeWhenIdle();
}

function recoveryClient(failed: OcrClient): OcrClient {
    if (recoveredClient === failed) {
        retireOcrClient(failed);
    }

    if (!recoveredClient) {
        const client = new DarwinKit({ timeout: 60_000, logger, logLevel: "warn" });
        const closer = createIdleCloser(() => {
            void client.close();
        });
        recoveredClient = { client, lease: () => closer.lease(), closer };
    }

    return recoveredClient;
}

function isEmptyOcrResult(result: OcrResult): boolean {
    if (result.text.trim().length > 0) {
        return false;
    }

    return result.blocks.length === 0;
}

async function callVisionOcr({
    imagePath,
    languages,
    level,
    timeoutMs,
    client,
}: {
    imagePath: string;
    languages: string[];
    level: OcrLevel;
    timeoutMs?: number;
    client: DarwinKit;
}): Promise<OcrResult> {
    return client.vision.ocr(
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

/**
 * The longest side of one tile of a `tiles` read, in image pixels. Vision reads each region at its own working size, so
 * a smaller tile reads smaller text, and each tile is one more request. Measured 2026-11-09 on 12 kept meeting frames
 * (2880×1205, 2880×1861 and 2560×1440), as the share of every dictionary word any grid read: one read 42 %, two
 * vertical strips 80 % (the rule before, and only for frames twice as wide as tall), a 3×2 grid 86 % at about 770 ms,
 * 4×2 88 % at 810 ms, 8×4 92 % at 1.8 s.
 */
export const DEFAULT_OCR_TILE_PX = 960;
/** Each tile reaches this share of the image past its inner edges, so a line on a seam is whole in one tile. */
const TILE_OVERLAP = 0.03;

/** The regions of a `tiles` read: a grid whose tiles are at most `tilePx` on their longest side, with overlap. */
export function planOcrTiles({ width, height }: ImageDimensions, tilePx = DEFAULT_OCR_TILE_PX) {
    const cols = Math.max(1, Math.ceil(width / tilePx));
    const rows = Math.max(1, Math.ceil(height / tilePx));
    const span = (index: number, count: number) => {
        const start = Math.max(0, index / count - (index > 0 ? TILE_OVERLAP : 0));
        const end = Math.min(1, (index + 1) / count + (index < count - 1 ? TILE_OVERLAP : 0));
        return { start, size: end - start };
    };
    const regions: Array<{ x: number; y: number; width: number; height: number }> = [];

    // Vision's y grows upwards: the top row goes first, so the merged text keeps the screen's order.
    for (let row = rows - 1; row >= 0; row--) {
        const y = span(row, rows);

        for (let col = 0; col < cols; col++) {
            const x = span(col, cols);
            regions.push({ x: x.start, y: y.start, width: x.size, height: y.size });
        }
    }

    return regions;
}

/** Region OCR already answers in full-image, bottom-left coordinates. Never scale those bounds again. */
export function mergeRegionOcrResults(parts: OcrResult[]): OcrResult {
    const blocks: OcrBlock[] = [];
    const fold = (text: string) => text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
    const overlapShare = (a: OcrBlock["bounds"], b: OcrBlock["bounds"]) => {
        const overlapWidth = Math.max(0, Math.min(+a.x + +a.width, +b.x + +b.width) - Math.max(+a.x, +b.x));
        const overlapHeight = Math.max(0, Math.min(+a.y + +a.height, +b.y + +b.height) - Math.max(+a.y, +b.y));
        const area = Math.min(+a.width * +a.height, +b.width * +b.height);
        return area > 0 ? (overlapWidth * overlapHeight) / area : 0;
    };

    for (const part of parts) {
        for (const block of part.blocks) {
            const text = fold(block.text);
            // The same line read twice, or a seam tile's cut piece of a line another tile read whole.
            const duplicate = blocks.findIndex((other) => {
                const otherText = fold(other.text);
                return (
                    (otherText.includes(text) || text.includes(otherText)) &&
                    overlapShare(other.bounds, block.bounds) > 0.5
                );
            });

            if (duplicate < 0) {
                blocks.push(block);
                continue;
            }

            const kept = fold(blocks[duplicate].text);
            const longer = text.length > kept.length;
            const sameText = text === kept;

            if (longer || (sameText && block.confidence > blocks[duplicate].confidence)) {
                blocks[duplicate] = block;
            }
        }
    }

    return { text: blocks.map((block) => block.text).join("\n"), blocks };
}

function needsAccurateTiling(dims: ImageDimensions): boolean {
    return dims.height > MAX_ACCURATE_DIMENSION || dims.width > MAX_ACCURATE_DIMENSION;
}

async function recognizeTextTiled({
    imagePath,
    dims,
    languages,
    level,
    client,
    timeoutMs,
}: {
    imagePath: string;
    dims: ImageDimensions;
    languages: string[];
    level: OcrLevel;
    client: DarwinKit;
    timeoutMs?: number;
}): Promise<OcrResult> {
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

            const result = await callVisionOcr({ imagePath: tempPath, languages, level, client, timeoutMs });
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
    const initial = recoveredClient ?? { client: getDarwinKit(), lease: leaseDarwinKit };
    const attempt = async (reader: OcrClient) => {
        const release = reader.lease();
        try {
            return await recognizeTextAttempt(imagePath, { ...options, client: reader.client });
        } finally {
            release();
        }
    };

    try {
        return await attempt(initial);
    } catch (error) {
        if (!imageReaderFailed(error)) {
            throw error;
        }

        // A poisoned Vision helper rejects valid frames too. Keep unrelated shared DarwinKit calls alive.
        const retry = recoveryClient(initial);
        logger.warn({ imagePath, error }, "darwin-ocr: image reader failed; retrying once in an OCR-only helper");
        try {
            return await attempt(retry);
        } catch (retryError) {
            if (imageReaderFailed(retryError)) {
                retireOcrClient(retry);
            }

            throw retryError;
        }
    }
}

async function recognizeTextAttempt(
    imagePath: string,
    options: OcrOptions & { client: DarwinKit }
): Promise<OcrResult> {
    const { client, timeoutMs } = options;
    const level = options.level ?? "accurate";
    const languages = options.languages ?? ["en-US"];

    const dimensions = level === "accurate" || options.read === "tiles" ? await getImageDimensions(imagePath) : null;

    if (level === "accurate") {
        const dims = dimensions;

        if (dims && needsAccurateTiling(dims)) {
            const tiled = await recognizeTextTiled({ imagePath, dims, languages, level, client, timeoutMs });

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

            for (const region of planOcrTiles(dims, options.tilePx)) {
                parts.push(
                    await client.vision.ocr(
                        {
                            path: imagePath,
                            languages,
                            level,
                            region,
                            language_correction: false,
                        },
                        timeoutMs ? { timeout: timeoutMs } : undefined
                    )
                );
            }

            return mergeRegionOcrResults(parts);
        }
    }

    const result = await callVisionOcr({ imagePath, languages, level, client, timeoutMs });

    if (level === "accurate" && options.fastFallback !== false && isEmptyOcrResult(result)) {
        logger.debug({ imagePath }, "darwin-ocr: accurate empty, falling back to fast");
        return callVisionOcr({ imagePath, languages, level: "fast", client, timeoutMs });
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

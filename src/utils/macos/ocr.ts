import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger } from "@app/logger";
import { getDarwinKit } from "./darwinkit";
import type { OcrBlock, OcrLevel, OcrResult } from "./types";

export interface OcrOptions {
    /** BCP-47 language codes to use for recognition. Default: ["en-US"] */
    languages?: string[];
    /** "fast" for speed, "accurate" for quality. Default: "accurate" */
    level?: OcrLevel;
}

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

async function callVisionOcr(imagePath: string, languages: string[], level: OcrLevel): Promise<OcrResult> {
    return getDarwinKit().vision.ocr({
        path: imagePath,
        languages,
        level,
    });
}

async function getImageDimensions(imagePath: string): Promise<ImageDimensions | null> {
    const proc = Bun.spawn(["sips", "-g", "pixelWidth", "-g", "pixelHeight", imagePath], {
        stdout: "pipe",
        stderr: "pipe",
    });

    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

    if (exitCode !== 0) {
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
        { stdout: "pipe", stderr: "pipe" }
    );

    const exitCode = await proc.exited;

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

    if (level === "accurate") {
        const dims = await getImageDimensions(imagePath);

        if (dims && needsAccurateTiling(dims)) {
            const tiled = await recognizeTextTiled(imagePath, dims, languages, level);

            if (!isEmptyOcrResult(tiled)) {
                return tiled;
            }

            logger.debug({ imagePath, dims }, "darwin-ocr: tiled accurate empty, falling back to fast");
        }
    }

    const result = await callVisionOcr(imagePath, languages, level);

    if (level === "accurate" && isEmptyOcrResult(result)) {
        logger.debug({ imagePath }, "darwin-ocr: accurate empty, falling back to fast");
        return callVisionOcr(imagePath, languages, "fast");
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

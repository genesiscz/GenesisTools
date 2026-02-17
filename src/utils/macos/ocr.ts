// src/utils/macos/ocr.ts

import { writeFileSync, unlinkSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { getDarwinKit } from "./darwinkit";
import type { OcrResult, OcrLevel } from "./types";

export interface OcrOptions {
  /** BCP-47 language codes to use for recognition. Default: ["en-US"] */
  languages?: string[];
  /** "fast" for speed, "accurate" for quality. Default: "accurate" */
  level?: OcrLevel;
}

/**
 * Extract text from an image file using Apple's Vision framework.
 * Coordinates in blocks are normalized (0–1) with bottom-left origin.
 *
 * @param imagePath - Absolute path to the image file (JPEG, PNG, TIFF, HEIC, PDF)
 */
export async function recognizeText(
  imagePath: string,
  options: OcrOptions = {},
): Promise<OcrResult> {
  return getDarwinKit().call<OcrResult>("vision.ocr", {
    path: imagePath,
    languages: options.languages ?? ["en-US"],
    level: options.level ?? "accurate",
  });
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
  options: OcrOptions = {},
): Promise<OcrResult> {
  const tempPath = join(tmpdir(), `darwin-ocr-${Date.now()}.${extension}`);
  try {
    writeFileSync(tempPath, buffer);
    return await recognizeText(tempPath, options);
  } finally {
    if (existsSync(tempPath)) {
      try { unlinkSync(tempPath); } catch {}
    }
  }
}

/**
 * Extract only the plain text string from an image file (no bounding boxes).
 */
export async function extractText(
  imagePath: string,
  options: OcrOptions = {},
): Promise<string> {
  const result = await recognizeText(imagePath, options);
  return result.text;
}

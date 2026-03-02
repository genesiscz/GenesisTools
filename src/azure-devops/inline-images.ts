/**
 * Azure DevOps CLI - Inline image extraction and download from work item HTML
 */

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Api } from "@app/azure-devops/api";
import logger from "@app/logger";
import { concurrentMap } from "@app/utils/async";

/** Parsed inline image reference from HTML */
export interface InlineImageRef {
    originalUrl: string;
    attachmentId: string;
    fileName: string;
    localFileName: string;
}

const ATTACHMENT_URL_PATTERN = /\/_apis\/wit\/attachments\/([a-f0-9-]+)/i;
const IMG_SRC_PATTERN = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;

/**
 * Extract Azure DevOps attachment image URLs from HTML content.
 * Returns deduplicated list of image references.
 */
export function extractInlineImageUrls(html: string, workItemId: number): InlineImageRef[] {
    if (!html) {
        return [];
    }

    const seen = new Set<string>();
    const images: InlineImageRef[] = [];

    for (const match of html.matchAll(IMG_SRC_PATTERN)) {
        const url = match[1];

        if (seen.has(url)) {
            continue;
        }

        seen.add(url);
        const attachmentMatch = url.match(ATTACHMENT_URL_PATTERN);

        if (!attachmentMatch) {
            continue;
        }

        const attachmentId = attachmentMatch[1];
        const fileName = extractFileName(url, attachmentId);
        const localFileName = `${workItemId}-${fileName}`;

        images.push({ originalUrl: url, attachmentId, fileName, localFileName });
    }

    return images;
}

/** Extract filename from URL query params or generate from UUID */
function extractFileName(url: string, attachmentId: string): string {
    try {
        const parsed = new URL(url);
        const fileName = parsed.searchParams.get("fileName");

        if (fileName) {
            return sanitizeFileName(fileName);
        }
    } catch {
        // Invalid URL, fall through
    }

    return `image-${attachmentId.slice(0, 8)}.png`;
}

/** Sanitize filename for filesystem */
function sanitizeFileName(name: string): string {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control char removal
    return name.replace(/[<>:"|?*\x00-\x1f]/g, "_");
}

/**
 * Download inline images to the output directory.
 * Skips already-existing files with matching content.
 * Returns map of originalUrl -> localFileName for URL rewriting.
 */
export async function downloadInlineImages(
    api: Api,
    images: InlineImageRef[],
    outputDir: string
): Promise<Map<string, string>> {
    if (images.length === 0) {
        return new Map();
    }

    const urlMap = new Map<string, string>();

    await concurrentMap({
        items: images,
        fn: async (img) => {
            const targetPath = join(outputDir, img.localFileName);

            if (existsSync(targetPath)) {
                const stat = statSync(targetPath);

                if (stat.size > 0) {
                    logger.debug(`[inline-images] Skipping ${img.localFileName} (already exists)`);
                    urlMap.set(img.originalUrl, img.localFileName);
                    return;
                }
            }

            try {
                const buffer = await api.fetchBinary(img.originalUrl, img.localFileName);
                await Bun.write(targetPath, buffer);
                logger.debug(`[inline-images] Downloaded ${img.localFileName} (${buffer.byteLength} bytes)`);
                urlMap.set(img.originalUrl, img.localFileName);
            } catch (error) {
                logger.warn(`[inline-images] Failed to download ${img.localFileName}: ${error}`);
            }
        },
        onError: (img, error) => {
            logger.warn(`[inline-images] Error downloading ${img.localFileName}: ${error}`);
        },
    });

    return urlMap;
}

/**
 * Rewrite image URLs in HTML to use local filenames.
 * Used before HTML-to-Markdown conversion so generated markdown references local files.
 */
export function rewriteImageUrls(html: string, urlMap: Map<string, string>): string {
    if (!html || urlMap.size === 0) {
        return html;
    }

    let result = html;

    for (const [originalUrl, localFileName] of urlMap) {
        result = result.replaceAll(originalUrl, localFileName);
    }

    return result;
}

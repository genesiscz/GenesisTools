/**
 * Azure DevOps CLI - Inline image extraction and download from work item HTML
 */

import { existsSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { Api } from "@app/azure-devops/api";
import { concurrentMap } from "@genesiscz/utils/async";
import { logger } from "@genesiscz/utils/logger";

/** Parsed inline image reference from HTML */
export interface InlineImageRef {
    originalUrl: string;
    attachmentId: string;
    fileName: string;
    localFileName: string;
}

const ATTACHMENT_URL_PATTERN = /\/_apis\/wit\/attachments\/([a-f0-9-]+)/i;
/** The first attribute named exactly `src` (a space before it, so `data-src` is not it). */
const IMG_SRC_PATTERN = /<img\b[^>]*?\ssrc=["']([^"']+)["'][^>]*>/gi;
/** {@link IMG_SRC_PATTERN} with the text before and after the src value captured too. */
const IMG_SRC_PARTS_PATTERN = /(<img\b[^>]*?\ssrc=["'])([^"']+)(["'][^>]*>)/gi;
/**
 * `![alt](url)`, `![alt](<url>)` or either with a `"title"`: comments written in ADO's markdown editor
 * carry images this way. An angle-bracket destination may hold `)` and spaces, so it has its own group;
 * a bare one may hold balanced parentheses (`?fileName=screen(1).png`).
 */
const MARKDOWN_IMAGE_PATTERN = /(!\[[^\]]*\]\(\s*)(?:<([^>\n]+)>|((?:[^()\s]|\([^()\s]*\))+))((?:\s+"[^"]*")?\s*\))/g;

function markdownImageUrl(match: RegExpMatchArray): string {
    return match[2] ?? match[3] ?? "";
}

/**
 * Where a markdown text holds code: fenced blocks (a fence closes on its own character, at least as long,
 * with nothing after it) and backtick spans. An image written there is an example, not an image.
 */
function codeRanges(text: string): Array<[number, number]> {
    const ranges: Array<[number, number]> = [];
    let fence: { char: string; length: number; start: number } | null = null;
    let offset = 0;

    for (const line of text.split("\n")) {
        const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);

        if (fence === null && marker) {
            fence = { char: marker[1][0], length: marker[1].length, start: offset };
        } else if (
            fence !== null &&
            marker &&
            marker[1][0] === fence.char &&
            marker[1].length >= fence.length &&
            line.slice(marker[0].length).trim() === ""
        ) {
            ranges.push([fence.start, offset + line.length]);
            fence = null;
        } else if (fence === null) {
            for (const span of line.matchAll(/(`+)[^`][\s\S]*?\1/g)) {
                ranges.push([offset + (span.index ?? 0), offset + (span.index ?? 0) + span[0].length]);
            }
        }

        offset += line.length + 1;
    }

    if (fence !== null) {
        ranges.push([fence.start, text.length]);
    }

    return ranges;
}

function inCode(ranges: Array<[number, number]>, at: number): boolean {
    return ranges.some(([from, to]) => at >= from && at < to);
}

/**
 * Extract Azure DevOps attachment image URLs from HTML or markdown content.
 * Returns deduplicated list of image references.
 */
export function extractInlineImageUrls(html: string, workItemId: number): InlineImageRef[] {
    if (!html) {
        return [];
    }

    const seen = new Set<string>();
    const images: InlineImageRef[] = [];
    const urls = [
        ...[...html.matchAll(IMG_SRC_PATTERN)].map((m) => m[1]),
        ...[...html.matchAll(MARKDOWN_IMAGE_PATTERN)]
            .filter((match) => !inCode(codeRanges(html), match.index ?? 0))
            .map(markdownImageUrl),
    ];

    for (const url of urls) {
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
        const localFileName = `${workItemId}-${attachmentId.slice(0, 8)}-${fileName}`;

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

/** Sanitize filename for filesystem — strips path components and dangerous characters */
function sanitizeFileName(name: string): string {
    const base = basename(name);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control char removal
    const safe = base.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/^\.+/, "_");
    return safe || "image.png";
}

/**
 * Download inline images to the output directory.
 * Skips already-existing non-empty files (does not verify content).
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

/** Rewrite only the `src` of each `<img>`: the rest of the text (a code example quoting the URL) stays. */
export function rewriteImageSources(text: string, urlMap: Map<string, string>): string {
    if (!text || urlMap.size === 0) {
        return text;
    }

    return text.replace(IMG_SRC_PARTS_PATTERN, (tag, before: string, src: string, after: string) => {
        const local = urlMap.get(src);
        return local ? `${before}${local}${after}` : tag;
    });
}

/**
 * Rewrite the image destinations of a markdown text to the downloaded files. A local name with a space
 * or a parenthesis is written as `<name>`, because a bare destination ends at the first space or `)`.
 */
export function rewriteMarkdownImageUrls(text: string, urlMap: Map<string, string>): string {
    if (!text || urlMap.size === 0) {
        return text;
    }

    const code = codeRanges(text);
    return text.replace(
        MARKDOWN_IMAGE_PATTERN,
        (whole, open: string, angled: string | undefined, bare: string | undefined, close: string, at: number) => {
            const local = urlMap.get(angled ?? bare ?? "");
            if (!local || inCode(code, at)) {
                return whole;
            }

            const destination = angled !== undefined || /[\s()]/.test(local) ? `<${local}>` : local;
            return `${open}${destination}${close ?? ""}`;
        }
    );
}

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { type ImageAttachment, MAX_IMAGE_ATTACHMENT_BYTES, MAX_IMAGE_PIXELS } from "@genesiscz/utils/image/attachments";
import { detectImageFormat } from "@genesiscz/utils/image/detect-format";
import { checkImageDimensions } from "@genesiscz/utils/image/dimensions";
import { logger } from "@genesiscz/utils/logger";
import { parseTranscludeText } from "@genesiscz/utils/transclude";

/**
 * Card text carries images three ways: a markdown image (what an `{{image}}` token or an item's `attachments`
 * resolve to), a raw `{{image path="…"}}` token (posted with transclusion off), or a bare absolute path in prose.
 * The widget draws the body with `Text(.init(markdown))`, which shows none of them as a picture, so every one of
 * them becomes a real attachment with the same shape answer cards already carry (`ImageAttachment`), and the
 * markdown image and the token leave the text. A bare path stays in the text: it is usually part of a sentence.
 */

const MARKDOWN_IMAGE = /!\[([^\]\n]*)\]\(\s*(<[^>\n]+>|[^)\s]+)(?:\s+"[^"\n]*")?\s*\)/g;
const BARE_IMAGE_PATH = /(?<![\w/.:~-])((?:file:\/\/)?\/[^\s"'`<>()[\]{}|]+\.(?:png|jpe?g|webp))(?![\w/])/gi;
const LIFTABLE_MIME = new Set(["image/png", "image/jpeg", "image/webp"]);

/** The image metadata of each file, by path, size and mtime: a refresh every few seconds must not re-hash it. */
const imageCache = new Map<string, Omit<ImageAttachment, "label"> | null>();
const IMAGE_CACHE_LIMIT = 256;

function localPath(target: string): string | null {
    const raw = target.startsWith("<") && target.endsWith(">") ? target.slice(1, -1) : target;

    if (raw.startsWith("file://")) {
        try {
            return fileURLToPath(raw);
        } catch (error) {
            logger.debug({ error, target }, "widget card image: not a file URL");
            return null;
        }
    }

    let decoded = raw;

    try {
        decoded = decodeURI(raw);
    } catch (error) {
        logger.debug({ error, target }, "widget card image: path is not URI-encoded");
    }

    return isAbsolute(decoded) ? decoded : null;
}

function describeImage(path: string): Omit<ImageAttachment, "label"> | null {
    let size: number;
    let mtime: number;

    try {
        const info = statSync(path);

        if (!info.isFile()) {
            return null;
        }

        size = info.size;
        mtime = info.mtimeMs;
    } catch (error) {
        logger.debug({ error, path }, "widget card image: path does not exist");
        return null;
    }

    const key = `${path}|${size}|${mtime}`;

    if (imageCache.has(key)) {
        return imageCache.get(key) ?? null;
    }

    let described: Omit<ImageAttachment, "label"> | null = null;

    if (size > 0 && size <= MAX_IMAGE_ATTACHMENT_BYTES) {
        try {
            const data = readFileSync(path);
            const format = detectImageFormat(data);

            if (format && LIFTABLE_MIME.has(format.mime)) {
                const { width, height } = checkImageDimensions({ data, maxPixels: MAX_IMAGE_PIXELS });
                described = {
                    type: "image",
                    id: `lifted-${createHash("sha256").update(path).digest("hex").slice(0, 16)}`,
                    name: basename(path),
                    path,
                    mimeType: format.mime as ImageAttachment["mimeType"],
                    bytes: data.length,
                    width,
                    height,
                    sha256: createHash("sha256").update(data).digest("hex"),
                };
            }
        } catch (error) {
            logger.debug({ error, path }, "widget card image: not a still PNG, JPEG or WebP image");
        }
    }

    if (imageCache.size >= IMAGE_CACHE_LIMIT) {
        imageCache.delete(imageCache.keys().next().value as string);
    }

    imageCache.set(key, described);
    return described;
}

/** The raw `{{image path=…}}` tokens of a text that name a liftable file, with the text they leave behind. */
function liftTokens(text: string, lift: (path: string, label?: string) => boolean): string {
    if (!text.includes("{{")) {
        return text;
    }

    const segments = parseTranscludeText(text);
    let lifted = false;
    const kept = segments.map((segment) => {
        if (segment.type === "text") {
            return segment.value;
        }

        const path = segment.kind === "image" && !segment.error ? segment.params.path : undefined;

        if (path && isAbsolute(path) && lift(path, segment.params.alt)) {
            lifted = true;
            return "";
        }

        return segment.raw;
    });

    return lifted ? kept.join("") : text;
}

/**
 * Lifts the images of a card's texts into attachments. `existing` are the card's stored attachments (answer cards);
 * a path already among them is not added twice. Returns the texts with lifted markdown images and tokens removed.
 */
export function liftCardImages(
    texts: string[],
    existing: ImageAttachment[] = []
): { texts: string[]; attachments: ImageAttachment[] } {
    const attachments = [...existing];
    const seen = new Set(existing.map((image) => image.path));

    const lift = (path: string, label?: string): boolean => {
        if (seen.has(path)) {
            return true;
        }

        const image = describeImage(path);

        if (!image) {
            return false;
        }

        seen.add(path);
        const named = label?.trim();
        attachments.push(named && named !== image.name ? { ...image, label: named } : image);
        return true;
    };

    const cleaned = texts.map((text) => {
        if (!text) {
            return text;
        }

        let next = liftTokens(text, lift).replace(MARKDOWN_IMAGE, (match, alt: string, target: string) => {
            const path = localPath(target);
            return path && lift(path, alt) ? "" : match;
        });

        for (const match of next.matchAll(BARE_IMAGE_PATH)) {
            const path = localPath(match[1]);

            if (path) {
                lift(path);
            }
        }

        next = next.replace(/\n{3,}/g, "\n\n").trim();
        return next === text.trim() ? text : next;
    });

    return { texts: cleaned, attachments };
}

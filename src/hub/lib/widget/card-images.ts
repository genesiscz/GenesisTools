import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { withTimeout } from "@genesiscz/utils/async";
import { type ImageAttachment, MAX_IMAGE_ATTACHMENT_BYTES, MAX_IMAGE_PIXELS } from "@genesiscz/utils/image/attachments";
import { detectImageFormat } from "@genesiscz/utils/image/detect-format";
import { checkImageDimensions } from "@genesiscz/utils/image/dimensions";
import { logger } from "@genesiscz/utils/logger";
import { mapOutsideCode } from "@genesiscz/utils/markdown/outside-code";
import { parseTranscludeText } from "@genesiscz/utils/transclude";

/**
 * Card text carries images three ways: a markdown image (what an `{{image}}` token or an item's `attachments`
 * resolve to), a raw `{{image path="…"}}` token (posted with transclusion off), or a bare absolute path in prose.
 * The widget draws the body with `Text(.init(markdown))`, which shows none of them as a picture, so every one of
 * them becomes a real attachment with the same shape answer cards already carry (`ImageAttachment`), and the
 * markdown image and the token leave the text. A bare path stays in the text: it is usually part of a sentence.
 * Code spans and fenced blocks are examples, not pictures: nothing in them is lifted or removed.
 */

/**
 * The destination is `<…>`, or a run that may hold balanced parentheses (`/tmp/shot(1).png`) down to two levels,
 * as CommonMark reads it. An unbalanced one needs the `<…>` form or percent-encoding.
 */
const MARKDOWN_IMAGE =
    /!\[([^\]\n]*)\]\(\s*(<[^>\n]+>|(?:[^()\s]|\((?:[^()\s]|\([^()\s]*\))*\))+)(?:\s+"[^"\n]*")?\s*\)/g;
const BARE_IMAGE_PATH = /(?<![\w/.:~-])((?:file:\/\/)?\/[^\s"'`<>()[\]{}|]+\.(?:png|jpe?g|webp))(?![\w/])/gi;
const LIFTABLE_MIME = new Set(["image/png", "image/jpeg", "image/webp"]);

/** The image metadata of each file, by path, size and mtime: a refresh every few seconds must not re-hash it. */
const imageCache = new Map<string, Omit<ImageAttachment, "label"> | null>();
const IMAGE_CACHE_LIMIT = 512;

/**
 * How long one image may hold a snapshot. Card text can name any absolute path, and a file on a network or removable
 * volume that went away answers a `stat` or a read late or never; the watch loop awaits the snapshot, so one such
 * image would stop every later inbox update and the shutdown that waits for the loop.
 */
const IMAGE_READ_DEADLINE_MS = 2_000;
/**
 * Reads still running after their caller gave up. A stalled file call cannot be cancelled and holds a worker thread
 * until the volume answers, so no more than this many stay in flight: past it a new image stays text.
 */
export const IMAGE_PENDING_LIMIT = 8;
const EXPIRED = new Error("widget card image: no answer within the deadline");

type DescribedImage = Omit<ImageAttachment, "label">;

/** The two file calls a card image costs, apart so a test can stall them; the disk answers in production. */
export interface ImageFiles {
    stat(path: string): Promise<Pick<Stats, "isFile" | "size" | "mtimeMs">>;
    bytes(path: string): Promise<Uint8Array<ArrayBuffer>>;
}

const diskFiles: ImageFiles = {
    stat: (path) => stat(path),
    bytes: (path) => Bun.file(path).bytes(),
};

interface ImageRead {
    result: Promise<DescribedImage | null>;
    /** Fired when the caller stopped waiting: the read ends where it is and leaves nothing behind. */
    abandoned: AbortController;
}

/** The read of each path that has not ended yet, so a path is never read twice at once, stalled or not. */
const reads = new Map<string, ImageRead>();

/** Settles once every read in flight has ended and left `reads`, abandoned ones included. Tests wait on it. */
export async function imageReadsSettled(): Promise<void> {
    await Promise.allSettled([...reads.values()].map((read) => read.result));
}

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

/**
 * What one snapshot may spend on card images. Reading and hashing a file it has not seen is the cost (up to the
 * attachment limit each), so a snapshot reads a few new files and leaves the rest as text for the next one, which
 * `deferred` asks for. The distinct paths one snapshot lifts stay under the cache size, so the files it read stay
 * cached for the next snapshot instead of pushing each other out.
 *
 * Time is spent too: one image is waited for at most `deadlineMs`, and the images of one snapshot together at most
 * `waitMs`. An image that did not answer stays text without being `deferred`, since asking for another snapshot at
 * once would only wait on the same stalled volume again.
 */
export class ImageLiftBudget {
    /** Images left as text because this snapshot's reads were spent: a later snapshot lifts them. */
    deferred = 0;
    private files: number;
    private bytes: number;
    private waitMs: number;
    private readonly deadlineMs: number;
    private readonly pathLimit: number;
    private readonly paths = new Set<string>();

    constructor({
        files = 8,
        bytes = 2 * MAX_IMAGE_ATTACHMENT_BYTES,
        paths = 128,
        deadlineMs = IMAGE_READ_DEADLINE_MS,
        waitMs = 2 * IMAGE_READ_DEADLINE_MS,
    }: { files?: number; bytes?: number; paths?: number; deadlineMs?: number; waitMs?: number } = {}) {
        this.files = files;
        this.bytes = bytes;
        this.waitMs = waitMs;
        this.deadlineMs = deadlineMs;
        this.pathLimit = Math.min(paths, IMAGE_CACHE_LIMIT / 2);
    }

    /** How long the next image may be waited for: its own deadline, within what this snapshot has left to wait. */
    nextDeadlineMs(): number {
        return Math.min(this.deadlineMs, this.waitMs);
    }

    /** Takes the time an image kept this snapshot waiting out of what it has left. */
    chargeWait(ms: number): void {
        this.waitMs = Math.max(0, this.waitMs - ms);
    }

    /** Whether this snapshot lifts `path` at all; past the path limit a new path stays text. */
    admits(path: string): boolean {
        if (this.paths.has(path)) {
            return true;
        }

        if (this.paths.size >= this.pathLimit) {
            return false;
        }

        this.paths.add(path);
        return true;
    }

    /** Takes one read of `size` bytes; false (and one more deferred image) when this snapshot has none left. */
    spend(size: number): boolean {
        if (this.files <= 0 || size > this.bytes) {
            this.deferred++;
            return false;
        }

        this.files--;
        this.bytes -= size;
        return true;
    }
}

/** WebCrypto hashes a large buffer off the JavaScript thread, so a 25 MB image does not hold the watch loop. */
async function sha256Hex(data: Uint8Array<ArrayBuffer>): Promise<string> {
    return Buffer.from(await crypto.subtle.digest("SHA-256", data)).toString("hex");
}

function remember(key: string, described: Omit<ImageAttachment, "label"> | null): void {
    // Least recently used first: a hit moves its entry to the end, so what the current cards show is evicted last.
    imageCache.delete(key);

    if (imageCache.size >= IMAGE_CACHE_LIMIT) {
        imageCache.delete(imageCache.keys().next().value as string);
    }

    imageCache.set(key, described);
}

/**
 * One image, waited for within the budget's deadline. A file call that does not answer in time leaves the image as
 * text. The read goes on in the thread pool, since a stalled file call cannot be stopped, so it is kept in `reads`:
 * a later snapshot neither starts a second read of the path nor waits on this one again, and nothing the late read
 * produces reaches a snapshot or the cache.
 */
async function describeImage(path: string, budget: ImageLiftBudget, files: ImageFiles): Promise<DescribedImage | null> {
    const running = reads.get(path);

    if (running?.abandoned.signal.aborted) {
        logger.debug({ path }, "widget card image: an earlier read of it is still waiting on the disk");
        return null;
    }

    const deadline = budget.nextDeadlineMs();

    if (deadline <= 0 || (!running && reads.size >= IMAGE_PENDING_LIMIT)) {
        logger.debug({ path, pending: reads.size }, "widget card image: left as text, the disk has stalled reads");
        return null;
    }

    const read = running ?? startRead(path, budget, files);
    const started = performance.now();

    try {
        return await withTimeout(read.result, deadline, EXPIRED);
    } catch (error) {
        if (error !== EXPIRED) {
            throw error;
        }

        if (!running) {
            read.abandoned.abort();
        }

        logger.warn({ path, deadlineMs: deadline }, "widget card image: the disk did not answer in time");
        return null;
    } finally {
        budget.chargeWait(performance.now() - started);
    }
}

function startRead(path: string, budget: ImageLiftBudget, files: ImageFiles): ImageRead {
    const abandoned = new AbortController();
    const read: ImageRead = {
        abandoned,
        result: readImage(path, budget, files, abandoned.signal).finally(() => {
            if (reads.get(path) === read) {
                reads.delete(path);
            }
        }),
    };
    reads.set(path, read);
    return read;
}

async function readImage(
    path: string,
    budget: ImageLiftBudget,
    files: ImageFiles,
    abandoned: AbortSignal
): Promise<DescribedImage | null> {
    let size: number;
    let mtime: number;

    try {
        const info = await files.stat(path);

        if (abandoned.aborted || !info.isFile()) {
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
        const cached = imageCache.get(key) ?? null;
        remember(key, cached);
        return cached;
    }

    let described: DescribedImage | null = null;

    if (size > 0 && size <= MAX_IMAGE_ATTACHMENT_BYTES) {
        if (!budget.spend(size)) {
            logger.debug({ path, size }, "widget card image: read left to a later snapshot");
            return null;
        }

        try {
            const bytes = await files.bytes(path);

            if (abandoned.aborted) {
                return null;
            }

            const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
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
                    sha256: await sha256Hex(bytes),
                };
            }
        } catch (error) {
            logger.debug({ error, path }, "widget card image: not a still PNG, JPEG or WebP image");
        }
    }

    if (abandoned.aborted) {
        return null;
    }

    remember(key, described);
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
 * `budget` is shared by every card of one snapshot; a card built alone gets its own. `files` is the disk; a test
 * passes a stalled one.
 */
export async function liftCardImages(
    texts: string[],
    {
        existing = [],
        budget = new ImageLiftBudget(),
        files = diskFiles,
    }: { existing?: ImageAttachment[]; budget?: ImageLiftBudget; files?: ImageFiles } = {}
): Promise<{ texts: string[]; attachments: ImageAttachment[] }> {
    const known = new Set(existing.map((image) => image.path));
    // The files are read first (without the event loop waiting on the disk), then the texts are rewritten with them.
    const wanted = new Set<string>();
    rewriteImages(texts, (path) => {
        wanted.add(path);
        return false;
    });
    const described = new Map<string, Omit<ImageAttachment, "label">>();

    for (const path of wanted) {
        if (known.has(path) || !budget.admits(path)) {
            continue;
        }

        const image = await describeImage(path, budget, files);

        if (image) {
            described.set(path, image);
        }
    }

    const attachments = [...existing];
    const seen = new Set(known);
    const cleaned = rewriteImages(texts, (path, label) => {
        if (seen.has(path)) {
            return true;
        }

        const image = described.get(path);

        if (!image) {
            return false;
        }

        seen.add(path);
        const named = label?.trim();
        attachments.push(named && named !== image.name ? { ...image, label: named } : image);
        return true;
    });

    return { texts: cleaned, attachments };
}

/** Each text without the images `lift` accepts; `lift` sees every image path, tokens first, in text order. */
function rewriteImages(texts: string[], lift: (path: string, label?: string) => boolean): string[] {
    return texts.map((text) => {
        if (!text) {
            return text;
        }

        // The token parser skips code on its own; markdown images and bare paths need `mapOutsideCode`.
        let next = mapOutsideCode(liftTokens(text, lift), (prose) => {
            const kept = prose.replace(MARKDOWN_IMAGE, (match, alt: string, target: string) => {
                const path = localPath(target);
                return path && lift(path, alt) ? "" : match;
            });

            for (const match of kept.matchAll(BARE_IMAGE_PATH)) {
                const path = localPath(match[1]);

                if (path) {
                    lift(path);
                }
            }

            return kept;
        });

        next = next.replace(/\n{3,}/g, "\n\n").trim();
        return next === text.trim() ? text : next;
    });
}

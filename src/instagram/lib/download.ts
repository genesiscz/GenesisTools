import { mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { InstagramError, type StoryItem, type StoryReel } from "./types";

const { log } = logger.scoped("instagram:download");

export interface DownloadResult {
    path: string;
    bytes: number;
    item: StoryItem;
}

/**
 * Everything in a file name except the timestamp is remote input. The owner
 * username and the item pk both come straight out of Instagram's JSON, so both
 * get reduced to a safe charset here rather than at each call site. Without
 * this a value carrying `/` or `..` walks `join()` right out of `outputDir`.
 */
function safeSegment(value: string): string {
    const cleaned = value
        // Separators are what make traversal possible at all.
        .replace(/[^\w.-]+/g, "_")
        // A single dot is legal in a username, `..` never is.
        .replace(/\.{2,}/g, "_")
        // Leading `.` hides the file; leading `-` reads as a flag to whatever opens it next.
        .replace(/^[.-]+/, "");

    return cleaned.length > 0 ? cleaned : "unknown";
}

/**
 * `mediaUrl` is remote input handed straight to `fetch`, and Bun's `fetch`
 * resolves `file://` as happily as `https://` — it answers 200 with the file's
 * contents. A media URL that is not https would therefore copy something off
 * this machine into the output directory wearing a story's file name, so the
 * scheme is checked before the request rather than trusted because of where the
 * JSON came from.
 */
function isDownloadableUrl(value: string): boolean {
    try {
        return new URL(value).protocol === "https:";
    } catch (error) {
        log.debug({ error, value }, "story item carried a media url that will not parse");
        return false;
    }
}

function fileNameFor(item: StoryItem, prefix: string): string {
    const stamp = item.takenAt.toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const ext = item.isVideo ? "mp4" : "jpg";
    return `${safeSegment(prefix)}_${stamp}_${safeSegment(item.id)}.${ext}`;
}

/**
 * Stream the body straight to disk and report how many bytes landed.
 *
 * Buffering with `arrayBuffer()` first held the whole file in memory before
 * writing a byte of it, which for story *videos* is an allocation the size of
 * the clip, and a reel downloads these back to back.
 */
async function streamToFile(response: Response, target: string): Promise<number> {
    if (!response.body) {
        throw new InstagramError("network", "Instagram's CDN returned a response with no body");
    }

    const writer = Bun.file(target).writer();
    const reader = response.body.getReader();
    let bytes = 0;

    try {
        let chunk = await reader.read();

        while (!chunk.done) {
            writer.write(chunk.value);
            bytes += chunk.value.byteLength;
            chunk = await reader.read();
        }

        await writer.end();
    } catch (error) {
        // A truncated .mp4 left on disk is worse than no file: nothing downstream
        // can tell it apart from a complete one, so it goes with the error.
        try {
            await writer.end();
        } catch (endError) {
            log.debug({ endError, target }, "failed to close the sink for a partial download");
        }

        await unlink(target).catch((cleanupError) => {
            log.debug({ cleanupError, target }, "could not remove the partial download");
        });

        throw error;
    }

    return bytes;
}

export async function downloadReels(
    reels: StoryReel[],
    outputDir: string,
    onProgress?: (done: number, total: number) => void
): Promise<DownloadResult[]> {
    await mkdir(outputDir, { recursive: true });

    const jobs = reels.flatMap((reel) =>
        reel.items.map((item) => ({ item, prefix: reel.ownerUsername ?? reel.reelId }))
    );
    const results: DownloadResult[] = [];

    // Sequential on purpose: these requests carry a live session cookie, and
    // parallel bursts against Instagram are what trips account-level blocks.
    for (const [index, job] of jobs.entries()) {
        const target = join(outputDir, fileNameFor(job.item, job.prefix));

        if (!isDownloadableUrl(job.item.mediaUrl)) {
            log.warn({ id: job.item.id }, "refusing a non-https media url");
            onProgress?.(index + 1, jobs.length);
            continue;
        }

        try {
            const response = await fetch(job.item.mediaUrl);

            if (!response.ok) {
                log.warn({ status: response.status, id: job.item.id }, "media download failed");
                continue;
            }

            const bytes = await streamToFile(response, target);
            results.push({ path: target, bytes, item: job.item });
            log.debug({ target, bytes }, "downloaded story item");
        } catch (error) {
            log.warn({ error, id: job.item.id }, "media download threw");
        }

        onProgress?.(index + 1, jobs.length);
    }

    if (jobs.length > 0 && results.length === 0) {
        throw new InstagramError("network", `All ${jobs.length} media downloads failed`);
    }

    return results;
}

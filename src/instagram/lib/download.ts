import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { InstagramError, type StoryItem, type StoryReel } from "./types";

const { log } = logger.scoped("instagram:download");

export interface DownloadResult {
    path: string;
    bytes: number;
    item: StoryItem;
}

function fileNameFor(item: StoryItem, prefix: string): string {
    const stamp = item.takenAt.toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const ext = item.isVideo ? "mp4" : "jpg";
    return `${prefix}_${stamp}_${item.id}.${ext}`;
}

export async function downloadReels(
    reels: StoryReel[],
    outputDir: string,
    onProgress?: (done: number, total: number) => void
): Promise<DownloadResult[]> {
    await mkdir(outputDir, { recursive: true });

    const jobs = reels.flatMap((reel) =>
        reel.items.map((item) => ({ item, prefix: reel.ownerUsername ?? reel.reelId.replace(/[^\w-]/g, "_") }))
    );
    const results: DownloadResult[] = [];

    // Sequential on purpose: these requests carry a live session cookie, and
    // parallel bursts against Instagram are what trips account-level blocks.
    for (const [index, job] of jobs.entries()) {
        const target = join(outputDir, fileNameFor(job.item, job.prefix));

        try {
            const response = await fetch(job.item.mediaUrl);

            if (!response.ok) {
                log.warn({ status: response.status, id: job.item.id }, "media download failed");
                continue;
            }

            const bytes = await response.arrayBuffer();
            await Bun.write(target, bytes);
            results.push({ path: target, bytes: bytes.byteLength, item: job.item });
            log.debug({ target, bytes: bytes.byteLength }, "downloaded story item");
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

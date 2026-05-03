import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import logger from "@app/logger";
import { SafeJSON } from "@app/utils/json";

export interface SayCacheParams {
    text: string;
    provider: string;
    voice?: string | null;
    model?: string | null;
    rate?: number | null;
    language?: string | null;
    format?: string | null;
}

export interface SayCacheHit {
    audio: Buffer;
    contentType: string;
}

interface IndexEntry {
    count: number;
    audioPath?: string;
    contentType?: string;
    lastUsed: number;
    sizeBytes: number;
}

interface IndexShape {
    version: 1;
    entries: Record<string, IndexEntry>;
}

const CONTENT_TYPE_TO_EXT: Record<string, string> = {
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/aiff": "aiff",
    "audio/x-aiff": "aiff",
    "audio/ogg": "ogg",
    "audio/opus": "opus",
    "audio/flac": "flac",
};

export interface SayAudioCacheOptions {
    /** Directory to store the index + audio files (e.g. ~/.genesis-tools/say/cache). */
    dir: string;
    /**
     * Number of identical-request misses to record before persisting audio.
     * The Nth call still synthesizes fresh; the (N+1)th hits disk. Default 5.
     */
    threshold?: number;
    /**
     * Total disk budget in bytes. When exceeded, oldest-by-`lastUsed` entries
     * are evicted. Default 50 MB.
     */
    maxBytes?: number;
}

/**
 * Hash-keyed disk cache for repeated cloud-TTS phrases. The same text/voice/
 * model/etc. tuple after `threshold` synthesizer calls gets persisted once and
 * served from disk forever after — saves cloud API spend on chronically
 * repeated phrases like "<task> done" notifications.
 *
 * Skipped entirely for `provider === "macos"`: that path is already free.
 */
export class SayAudioCache {
    private readonly dir: string;
    private readonly threshold: number;
    private readonly maxBytes: number;
    private readonly indexPath: string;

    constructor(opts: SayAudioCacheOptions) {
        this.dir = opts.dir;
        this.threshold = opts.threshold ?? 5;
        this.maxBytes = opts.maxBytes ?? 50_000_000;
        this.indexPath = join(this.dir, "index.json");

        if (!existsSync(this.dir)) {
            mkdirSync(this.dir, { recursive: true });
        }
    }

    private hash(p: SayCacheParams): string {
        const canon = SafeJSON.stringify({
            t: p.text,
            p: p.provider,
            v: p.voice ?? "",
            m: p.model ?? "",
            r: p.rate ?? 1,
            l: p.language ?? "",
            f: p.format ?? "",
        });
        return createHash("sha256").update(canon).digest("hex").slice(0, 32);
    }

    private readIndex(): IndexShape {
        if (!existsSync(this.indexPath)) {
            return { version: 1, entries: {} };
        }

        try {
            return SafeJSON.parse(readFileSync(this.indexPath, "utf8")) as IndexShape;
        } catch {
            return { version: 1, entries: {} };
        }
    }

    private writeIndex(idx: IndexShape): void {
        writeFileSync(this.indexPath, SafeJSON.stringify(idx, null, 2));
    }

    private skip(p: SayCacheParams): boolean {
        return p.provider === "macos";
    }

    /** Returns hit data if cached audio is available, else `null`. */
    get(p: SayCacheParams): SayCacheHit | null {
        if (this.skip(p)) {
            return null;
        }

        const idx = this.readIndex();
        const key = this.hash(p);
        const entry = idx.entries[key];

        if (!entry) {
            return null;
        }

        // If the audio file went missing (manual delete, eviction race,
        // disk wipe), clear the stale metadata so the next miss can persist
        // a replacement instead of skipping forever.
        if (entry.audioPath && !existsSync(entry.audioPath)) {
            entry.audioPath = undefined;
            entry.contentType = undefined;
            entry.sizeBytes = 0;
            this.writeIndex(idx);
            return null;
        }

        if (entry.count < this.threshold || !entry.audioPath) {
            return null;
        }

        entry.lastUsed = Date.now();
        this.writeIndex(idx);
        return { audio: readFileSync(entry.audioPath), contentType: entry.contentType ?? "audio/mpeg" };
    }

    /**
     * Record a cache miss. Increments the counter; when the threshold is
     * crossed AND audio bytes are supplied, persists them so the next call
     * hits. Pass `audio`/`contentType` only when you actually have the
     * synthesized buffer (cloud providers).
     */
    recordMiss(p: SayCacheParams, audio?: Buffer, contentType?: string): void {
        if (this.skip(p)) {
            return;
        }

        const idx = this.readIndex();
        const key = this.hash(p);
        const existing: IndexEntry = idx.entries[key] ?? { count: 0, lastUsed: Date.now(), sizeBytes: 0 };
        existing.count += 1;
        existing.lastUsed = Date.now();

        // If a previously-persisted audio file vanished under us, drop the
        // stale path so the persist-branch below can write a replacement.
        if (existing.audioPath && !existsSync(existing.audioPath)) {
            existing.audioPath = undefined;
            existing.contentType = undefined;
            existing.sizeBytes = 0;
        }

        if (existing.count >= this.threshold && !existing.audioPath && audio && contentType) {
            const ext = CONTENT_TYPE_TO_EXT[contentType] ?? "bin";
            const audioPath = join(this.dir, `${key}.${ext}`);
            writeFileSync(audioPath, audio);
            existing.audioPath = audioPath;
            existing.contentType = contentType;
            existing.sizeBytes = audio.byteLength;
        }

        idx.entries[key] = existing;
        this.evictIfOverCap(idx);
        this.writeIndex(idx);
    }

    private evictIfOverCap(idx: IndexShape): void {
        const total = Object.values(idx.entries).reduce((sum, e) => sum + e.sizeBytes, 0);

        if (total <= this.maxBytes) {
            return;
        }

        const ranked = Object.entries(idx.entries)
            .filter(([, e]) => e.audioPath)
            .sort(([, a], [, b]) => a.lastUsed - b.lastUsed);
        let running = total;

        for (const [key, e] of ranked) {
            if (running <= this.maxBytes) {
                break;
            }

            if (e.audioPath && existsSync(e.audioPath)) {
                try {
                    unlinkSync(e.audioPath);
                } catch (err) {
                    logger.debug(`[say/cache] evict failed: ${err}`);
                }
            }

            running -= e.sizeBytes;
            delete idx.entries[key];
        }
    }
}

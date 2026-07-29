import { existsSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { DIARIZE_MODEL_DIR } from "@genesiscz/utils/audio/diarize-models";
import { formatBytes } from "@genesiscz/utils/format";
import { logger, out } from "@genesiscz/utils/logger";
import { aiDataDir } from "../../config/paths";
import type { ArtifactRef } from "../descriptors/types";
import { HfSource } from "./sources/hf";
import { type ArtifactFetcher, UrlSource } from "./sources/url";
import type { CachedArtifact, PruneReport, ResolvedArtifact } from "./types";

/**
 * The sherpa diarization models predate this store and live under the
 * transcribe tool's directory (`~/.genesis-tools/transcribe/models/diarization`).
 * Registering it as a legacy root means `list()` and `prune()` see those
 * weights instead of orphaning ~31 MB; nothing is relocated, because a
 * relocation the user did not ask for is a silent re-download.
 */
export const LEGACY_SHERPA_ROOT = DIARIZE_MODEL_DIR;

export interface ArtifactStoreOptions {
    /** Where url artifacts land when a ref does not name its own absolute file. */
    root?: string;
    /** Listed and prunable, never written to. */
    legacyRoots?: string[];
    hf?: HfSource;
    fetcher?: ArtifactFetcher;
}

/**
 * One place that knows where on-device weights live, what is already there and
 * how to get rid of them.
 *
 * It deliberately does NOT own the HuggingFace cache location — transformers.js
 * resolves that itself and downloads as a side effect of building a pipeline.
 * The hub is registered as a root so it can be listed, sized and pruned through
 * the same surface as everything else.
 *
 * `prune()` is never called automatically. Deleting weights is a
 * user-confirmed CLI action.
 */
export class ArtifactStore {
    private readonly root: string;
    private readonly legacyRoots: string[];
    private readonly hf: HfSource;
    private readonly url: UrlSource;

    constructor(options: ArtifactStoreOptions = {}) {
        this.root = options.root ?? aiDataDir("local-models");
        this.legacyRoots = options.legacyRoots ?? [];
        this.hf = options.hf ?? new HfSource();
        this.url = new UrlSource(options.fetcher);
    }

    static default(): ArtifactStore {
        return new ArtifactStore({ legacyRoots: [LEGACY_SHERPA_ROOT] });
    }

    /** Where url artifacts without an explicit path are written. */
    getRoot(): string {
        return this.root;
    }

    /**
     * Make every ref exist on disk. HF refs are resolved, not fetched: the
     * transformers.js runtime downloads them when it builds the pipeline, so
     * forcing a download here would either duplicate that work or (worse) pull
     * the wrong files by guessing at the pipeline task.
     */
    async ensure(refs: ArtifactRef[]): Promise<ResolvedArtifact[]> {
        const resolved: ResolvedArtifact[] = [];

        for (const ref of refs) {
            if (ref.source === "hf") {
                await this.hf.resolveTransformersCache();
                const cached = this.hf.isCached(ref.locator);
                resolved.push({
                    ref,
                    path: this.hf.cachedPath(ref.locator) ?? this.hf.expectedPath(ref.locator),
                    cached,
                });
                continue;
            }

            const target = ref.file ? ref : { ...ref, file: `${this.root}/${ref.locator.split("/").pop()}` };
            const result = await this.url.ensure(target);
            resolved.push({ ref: target, path: result.path, cached: result.cached });
        }

        return resolved;
    }

    /** Everything cached across the HF roots, this store's root and the legacy roots. */
    async list(): Promise<CachedArtifact[]> {
        await this.hf.resolveTransformersCache();

        const artifacts = [...this.hf.list()];

        for (const root of [this.root, ...this.legacyRoots]) {
            artifacts.push(...this.url.list(root));
        }

        return artifacts;
    }

    async stats(): Promise<{ totalBytes: number; formatted: string; artifactCount: number }> {
        const artifacts = await this.list();
        const totalBytes = artifacts.reduce((sum, a) => sum + a.sizeBytes, 0);

        return { totalBytes, formatted: formatBytes(totalBytes), artifactCount: artifacts.length };
    }

    /**
     * Remove cached artifacts. Never invoked by the runtimes — this is the
     * body of a CLI command that has already asked the user.
     */
    async prune(options: { olderThanDays?: number; ids?: string[] } = {}): Promise<PruneReport> {
        const artifacts = await this.list();
        const cutoff = options.olderThanDays === undefined ? null : Date.now() - options.olderThanDays * 86_400_000;
        const wanted = options.ids ? new Set(options.ids) : null;
        const removed: CachedArtifact[] = [];

        for (const artifact of artifacts) {
            if (wanted && !wanted.has(artifact.id)) {
                continue;
            }

            if (cutoff !== null && artifact.mtimeMs >= cutoff) {
                continue;
            }

            await rm(artifact.path, { recursive: true, force: true });
            removed.push(artifact);
            logger.info(`Removed cached artifact: ${artifact.id} (${formatBytes(artifact.sizeBytes)})`);
        }

        return { removed, freedBytes: removed.reduce((sum, a) => sum + a.sizeBytes, 0) };
    }
}

let legacyRootNoticeShown = false;

/**
 * Tell the user once per process that weights are sitting outside the store's
 * root. Purely informational — nothing moves until they run the migration.
 */
export function noticeLegacyRoots(roots: string[] = [LEGACY_SHERPA_ROOT]): void {
    if (legacyRootNoticeShown) {
        return;
    }

    const populated = roots.filter((root) => existsSync(root) && statSync(root).isDirectory());

    if (populated.length === 0) {
        return;
    }

    legacyRootNoticeShown = true;
    logger.debug({ roots: populated }, "[artifacts] legacy model roots in use");
    out.log.info(
        `On-device model weights are still cached at ${populated.join(", ")}. ` +
            `Run \`tools ai models migrate-cache\` to move them under the artifact store.`
    );
}

/** Test seam: the notice is once-per-process, which a second test would never see. */
export function _resetLegacyRootNoticeForTest(): void {
    legacyRootNoticeShown = false;
}

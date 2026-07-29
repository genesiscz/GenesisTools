import type { ArtifactRef } from "../descriptors/types";

/** One artifact after `ensure()` has made sure it exists on disk. */
export interface ResolvedArtifact {
    ref: ArtifactRef;
    /** Absolute path to the file or model directory. */
    path: string;
    /** False when this call had to fetch it. */
    cached: boolean;
}

/** One artifact found by a `list()` sweep across the registered roots. */
export interface CachedArtifact {
    /** HF repo id for hub entries, file name for url entries. */
    id: string;
    source: ArtifactRef["source"];
    root: string;
    path: string;
    sizeBytes: number;
    mtimeMs: number;
}

export interface PruneReport {
    removed: CachedArtifact[];
    freedBytes: number;
}

export interface ArtifactProgress {
    /** HF repo id or file name. */
    id: string;
    loadedBytes: number;
    totalBytes?: number;
}

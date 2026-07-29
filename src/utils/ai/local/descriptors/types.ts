import type { ModelEntry } from "../../types";

/** Where a weight file comes from. `hf` locators are repo ids, `url` locators are absolute URLs. */
export interface ArtifactRef {
    source: "hf" | "url";
    locator: string;
    /**
     * Absolute path the artifact must end up at. `url` sources need it (nothing
     * else can derive it); `hf` sources leave it unset because transformers.js
     * owns its own cache layout.
     */
    file?: string;
    /** Set only where upstream publishes one — none of the current sources do. */
    sha256?: string;
    /** `url` artifacts shipped as a tarball are extracted rather than written as-is. */
    archive?: "tar.bz2";
    /**
     * Directory a `tar.bz2` unpacks into. The archive carries its own top-level
     * folder, so this is the parent of that folder, not of `file` — `file` is
     * then the path the archive is expected to yield, and a miss is an error.
     * Defaults to `file`'s directory, which is only right for flat archives.
     */
    archiveRoot?: string;
}

/** On-device execution backends. Hosted models have no runtime. */
export type LocalRuntimeId = "transformers-js" | "coreml" | "sherpa" | "darwinkit" | "ollama";

/**
 * A registry entry plus the two things the local stack needs to act on it:
 * which runtime executes it, and which weights must exist first.
 *
 * Field names stay those of `ModelEntry` (`dimensions`, `taskPrefix`) rather
 * than the shorter names in the Phase 6 freeze — renaming them would churn
 * every consumer of the shared type for no behavior gain.
 */
export interface LocalModelDescriptor extends ModelEntry {
    /** Absent for hosted (cloud/openai/google) entries. */
    runtime?: LocalRuntimeId;
    /** Empty when the weights are not ours to fetch (hosted APIs, OS built-ins, ollama daemon). */
    artifacts: ArtifactRef[];
    meta?: Record<string, unknown>;
}

/** A context artifact defined in .genesistoolscontext.json */
export interface ContextArtifact {
    /** Unique name for this artifact (e.g. "database-schema", "api-spec") */
    name: string;
    /** Path to the file or directory (relative to project root or absolute) */
    path: string;
    /** Human-readable description explaining what this artifact is */
    description: string;
}

/** Runtime state of an indexed artifact, persisted alongside IndexMeta */
export interface ArtifactIndexState {
    name: string;
    description: string;
    /** Resolved absolute path */
    resolvedPath: string;
    /** SHA-256 content hash (first 16 hex chars) at last index time */
    contentHash: string;
    /** ISO timestamp of last indexing */
    lastIndexedAt: string;
    /** Number of chunks stored */
    chunksIndexed: number;
}

/** Shape of the .genesistoolscontext.json config file */
export interface ContextConfig {
    artifacts?: ContextArtifact[];
}

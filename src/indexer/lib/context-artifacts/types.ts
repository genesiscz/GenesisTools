/** A context artifact defined in .genesistoolscontext.json */
export interface ContextArtifact {
    /** e.g. "database-schema", "api-spec" */
    name: string;
    /** Relative to project root or absolute */
    path: string;
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
    lastIndexedAt: string;
    chunksIndexed: number;
}

export interface ContextConfig {
    artifacts?: ContextArtifact[];
}

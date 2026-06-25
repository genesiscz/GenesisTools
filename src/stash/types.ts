export interface StashRow {
    id: string;
    name: string;
    tags: string | null;
    description: string | null;
    created_at: string;
    updated_at: string;
}

export interface VersionRow {
    id: string;
    stash_id: string;
    version: number;
    patch_ref: string;
    source_repo_path: string | null;
    source_origin: string | null;
    source_sha: string | null;
    region_count: number;
    file_count: number;
    metadata_json: string;
    created_at: string;
}

export interface ApplicationRow {
    id: string;
    stash_id: string;
    /** Nullable: set NULL when the referenced version is dropped (audit row survives). */
    version_id: string | null;
    project_path: string;
    project_origin: string | null;
    project_sha_at_apply: string | null;
    applied_at: string;
    state: "active" | "unapplying" | "unapplied" | "orphaned";
    unapplied_at: string | null;
}

export interface RegionRow {
    id: string;
    version_id: string;
    region_name: string | null;
    file_path: string;
    hunk_index: number;
    start_marker_present: number;
    line_count: number;
}

export interface ProjectRow {
    id: string;
    path: string;
    origin: string | null;
    tree_hash: string | null;
    last_seen: string;
}

/**
 * The contract both enrichers share. It lives here rather than in either crawler so neither
 * one has to import the other for a type that belongs to both.
 */
export interface EnrichOptions {
    dataDir: string;
    /**
     * Required, not optional, because it only matters when something fails. Both crawls load
     * the artist index, and its "run `tools spotify build`" error can only name the right
     * profile if it was told one. As an optional hint both call sites simply omitted it, and
     * the printed fix rebuilt the default profile instead of the broken one.
     */
    profile: string;
    limit?: number;
    /** Called every 25 artists and once at the end, so the CLI can show progress. */
    onProgress?: (done: number, total: number) => void;
}

export interface EnrichResult {
    total: number;
    cached: number;
    fetched: number;
}

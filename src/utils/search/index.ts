export type { OramaSearchEngineConfig } from "./drivers/orama";
export { OramaSearchEngine } from "./drivers/orama";
export type {
    FTS5TableOverrides,
    SearchEngineConfig,
    SearchEngineConfig as FTS5SearchEngineConfig,
} from "./drivers/sqlite-fts5";
// Backward compat aliases
export { SearchEngine, SearchEngine as FTS5SearchEngine } from "./drivers/sqlite-fts5";
export type {
    SqliteTextStoreConfig,
    SqliteVectorStoreConfig,
    TextSearchHit,
    TextStore,
    VectorSearchHit,
    VectorStore,
} from "./stores";
export { SqliteTextStore, SqliteVectorStore } from "./stores";
export type { SearchEngine as ISearchEngine, SearchOptions, SearchResult } from "./types";

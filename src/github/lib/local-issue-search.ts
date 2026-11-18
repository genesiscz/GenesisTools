import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { maxEmbedChars } from "@genesiscz/utils/ai/local/descriptors";
import { AIDarwinKitProvider } from "@genesiscz/utils/ai/providers/AIDarwinKitProvider";
import type { AIEmbeddingProvider } from "@genesiscz/utils/ai/types";
import type { SearchCommandOptions, SearchResult } from "@genesiscz/utils/github/types";
import { parseRepo } from "@genesiscz/utils/github/url-parser";
import { logger } from "@genesiscz/utils/logger";
import { SearchEngine } from "@genesiscz/utils/search/drivers/sqlite-fts5";
import { ensureExtensionCapableSQLite, loadSqliteVec } from "@genesiscz/utils/search/stores/sqlite-vec-loader";
import { SqliteVecVectorStore } from "@genesiscz/utils/search/stores/sqlite-vec-store";
import { SqliteVectorStore } from "@genesiscz/utils/search/stores/sqlite-vector-store";
import { githubCachePath } from "./cache";

type LocalMode = "semantic" | "hybrid";

function localQuery(query: string, options: SearchCommandOptions) {
    if (
        options.type === "repo" ||
        options.advanced ||
        options.legacy ||
        options.language ||
        options.minStars !== undefined ||
        options.sort
    ) {
        throw new Error(
            "Local issue search ranks cached issues and PRs by relevance. Choose keyword search for repository search, backend selection, stars, language or explicit sorting."
        );
    }
    const clauses = ["i.state IN ('open','closed')"];
    const params: Array<string | number> = [];
    const addRepo = (repo: string) => {
        const parsed = parseRepo(repo);
        if (!parsed) {
            throw new Error(`Invalid repository "${repo}". Use owner/repo.`);
        }
        clauses.push("r.owner = ? COLLATE NOCASE AND r.name = ? COLLATE NOCASE");
        params.push(parsed.owner, parsed.repo);
    };
    const addKind = (kind: string) => {
        if (kind === "all") {
            return;
        }
        if (kind !== "issue" && kind !== "pr") {
            throw new Error("Choose issue, pr or all.");
        }
        clauses.push("i.type = ?");
        params.push(kind);
    };
    const addState = (state: string) => {
        if (state === "all") {
            return;
        }
        if (state !== "open" && state !== "closed") {
            throw new Error("Choose open, closed or all.");
        }
        clauses.push("i.state = ?");
        params.push(state);
    };
    const minimum = (value: number) => {
        if (!Number.isSafeInteger(value) || value < 0) {
            throw new Error("Reaction thresholds must be nonnegative integers.");
        }
        return value;
    };
    let minReactions = options.minReactions;
    if (options.repo) {
        addRepo(options.repo);
    }
    if (options.type) {
        addKind(options.type);
    }
    if (options.state) {
        addState(options.state);
    }
    const terms: string[] = [];
    for (const token of query.match(/"[^"]*"|\S+/g) ?? []) {
        const qualifier = /^([\w-]+):(.+)$/.exec(token);
        if (!qualifier) {
            terms.push(token.replace(/^"|"$/g, ""));
            continue;
        }
        const [, key, value] = qualifier;
        if (key === "repo") {
            addRepo(value);
        } else if (key === "state" || (key === "is" && (value === "open" || value === "closed"))) {
            addState(value);
        } else if (key === "type" || key === "is") {
            addKind(value);
        } else if (key === "reactions" && /^>=\d+$/.test(value)) {
            minReactions = Math.max(minReactions ?? 0, Number(value.slice(2)));
        } else {
            throw new Error(`Unsupported local qualifier "${token}". Use keyword search for GitHub query syntax.`);
        }
    }
    if (options.minCommentReactions !== undefined) {
        clauses.push("EXISTS (SELECT 1 FROM comments c WHERE c.issue_id=i.id AND c.reaction_count >= ?)");
        params.push(minimum(options.minCommentReactions));
    }
    if (minReactions !== undefined) {
        clauses.push("reactions >= ?");
        params.push(minimum(minReactions));
    }
    const text = terms.join(" ").trim();
    if (!text) {
        throw new Error("Include words to search for alongside the filters.");
    }
    const limit = options.limit ?? 30;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new Error("Local search --limit must be between 1 and 100.");
    }
    return { text, limit, where: clauses.join(" AND "), params };
}

type CachedHit = Omit<SearchResult, "url" | "source"> & { id: number; body: string };

export async function searchCachedIssues(
    query: string,
    mode: LocalMode,
    options: SearchCommandOptions,
    {
        cachePath = githubCachePath(),
        embedder = new AIDarwinKitProvider(),
    }: { cachePath?: string; embedder?: Pick<AIEmbeddingProvider, "embed" | "isAvailable" | "dimensions"> } = {}
): Promise<SearchResult[]> {
    const { text, limit, where, params } = localQuery(query, options);
    if (!existsSync(cachePath)) {
        return [];
    }
    ensureExtensionCapableSQLite();
    const cache = new Database(cachePath, { readonly: true });
    let issues: CachedHit[];
    try {
        // A read-only search can open a cache created before reaction/comment totals were stored.
        const columns = new Set(
            cache
                .query<{ name: string }, []>("PRAGMA table_info(issues)")
                .all()
                .map((row) => row.name)
        );
        if (!columns.size) {
            return [];
        }
        issues = cache
            .query<CachedHit, Array<string | number>>(`
            SELECT i.id, i.number, i.type, i.title, COALESCE(i.body,'') AS body, i.state, i.author,
                   i.created_at AS createdAt, i.updated_at AS updatedAt, r.owner || '/' || r.name AS repo,
                   ${columns.has("comment_total") ? "i.comment_total" : "NULL"} AS comments,
                   ${columns.has("reaction_total") ? "i.reaction_total" : "NULL"} AS reactions
            FROM issues i JOIN repos r ON r.id = i.repo_id WHERE ${where} ORDER BY r.owner, r.name, i.number
        `)
            .all(...params);
    } finally {
        cache.close();
    }
    if (!issues.length) {
        return [];
    }
    if (!(await embedder.isAvailable())) {
        throw new Error("Local semantic and hybrid search require DarwinKit's on-device sentence embeddings on macOS.");
    }

    const db = new Database(":memory:");
    try {
        const config = { tableName: "issue_search", dimensions: embedder.dimensions };
        const vectors = loadSqliteVec(db) ? new SqliteVecVectorStore(db, config) : new SqliteVectorStore(db, config);
        const engine = SearchEngine.fromDatabase<{ id: string; title: string; body: string }>(db, {
            tableName: config.tableName,
            schema: { idField: "id", textFields: ["title", "body"] },
            vectorStore: vectors,
        });
        const byId = new Map(issues.map((issue) => [String(issue.id), issue]));
        const maxChars = maxEmbedChars("darwinkit");
        const embed = async (value: string) => {
            const { vector } = await embedder.embed(value.slice(0, maxChars), { language: "en" });
            if (
                vector.length !== embedder.dimensions ||
                !vector.every(Number.isFinite) ||
                !vector.some((v) => v !== 0)
            ) {
                throw new Error("DarwinKit could not produce a usable English sentence embedding.");
            }
            return vector;
        };
        const queryVector = await embed(text);
        for (const [id, issue] of byId) {
            await engine.insert({ id, title: issue.title, body: issue.body });
            vectors.store(id, await embed(`${issue.title}\n${issue.body}`));
        }
        const hits =
            mode === "semantic"
                ? await engine.cosineSearch(queryVector, limit)
                : await engine.rrfHybridSearch({ query: text, queryEmbedding: queryVector, limit });
        logger.debug({ mode, candidates: issues.length, hits: hits.length }, "Ranked locally cached GitHub issues");
        return hits.map(({ doc }) => {
            const issue = byId.get(doc.id);
            if (!issue) {
                throw new Error(`Missing cached issue for search hit ${doc.id}`);
            }
            const { id: _id, body: _body, ...row } = issue;
            return {
                ...row,
                source: `local-${mode}`,
                url: `https://github.com/${row.repo}/${row.type === "pr" ? "pull" : "issues"}/${row.number}`,
            };
        });
    } finally {
        db.close();
    }
}
